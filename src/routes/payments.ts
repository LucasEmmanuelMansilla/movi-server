import { Router } from 'express';
import { z } from 'zod';
import { createAdminClient } from '../lib/supabase';
import { MercadoPagoService } from '../services/mercadopago.service';
import { StatusCodes } from 'http-status-codes';
import asyncHandler from 'express-async-handler';
import { logger } from '../utils/logger';
import { validateBody, validateParams } from '../utils/validation';
import type { Role } from '../types';
import { sendPush } from './push';
import type { Json } from '../supabase.types';
import { parseAddressWithCoordinates, geocodeAddress, filterNearbyUsers } from '../utils/geolocation';
import { env } from '../env';

const router = Router();
const mpService = MercadoPagoService.getInstance();

// Aplicar middleware de autenticación a todas las rutas excepto webhook y redirects
import { authMiddleware } from '../middleware/auth';

/**
 * Función auxiliar para procesar pago aprobado (reutilizable)
 */
async function processApprovedPayment(
  paymentRecord: any,
  externalReference: string,
  admin: ReturnType<typeof createAdminClient>
) {
  try {
    const { data: shipment } = await admin
      .from('shipments')
      .select('id, title, current_status, pickup_address')
      .eq('id', externalReference)
      .single();

    if (shipment && shipment.current_status === 'draft') {
      await admin
        .from('shipments')
        .update({ current_status: 'created' })
        .eq('id', shipment.id);

      logger.info('Envío publicado después de pago aprobado', { shipmentId: shipment.id });

      // Notificar a drivers cercanos
      try {
        const parsedPickup = parseAddressWithCoordinates(shipment.pickup_address);
        let lat = parsedPickup.lat, lng = parsedPickup.lng;

        if (!lat || !lng) {
          const coords = await geocodeAddress(parsedPickup.address);
          if (coords) { lat = coords.lat; lng = coords.lng; }
        }

        if (lat && lng) {
          const { data: drivers } = await admin
            .from('profiles')
            .select('id, latitude, longitude')
            .eq('role', 'driver')
            .eq('is_available', true);

          if (drivers) {
            const nearby = filterNearbyUsers(drivers as any[], lat, lng, 10);
            if (nearby.length > 0) {
              const { data: tokens } = await admin
                .from('push_tokens')
                .select('token')
                .in('user_id', nearby.map(d => d.id));
              
              if (tokens?.length) {
                await sendPush(tokens.map(t => t.token), 'Nuevo envío disponible', `${shipment.title}`);
              }
            }
          }
        }
      } catch (e) {
        logger.error('Error en notificaciones de nuevo envío', e as Error);
      }
    }

    // Notificar al pagador
    const { data: tokens } = await admin
      .from('push_tokens')
      .select('token')
      .eq('user_id', paymentRecord.payer_id);

    if (tokens?.length) {
      await sendPush(tokens.map(t => t.token), 'Pago aprobado', `Tu envío "${shipment?.title}" está activo.`);
    }
  } catch (error) {
    logger.error('Error procesando pago aprobado', error as Error);
  }
}

const CreatePaymentBody = z.object({
  shipmentId: z.string().uuid(),
  payerEmail: z.string().email(),
  payerName: z.string().optional(),
});

/**
 * POST /payments/create
 */
router.post('/create', validateBody(CreatePaymentBody), authMiddleware, asyncHandler(async (req, res) => {
  const user = req.user;
  const { shipmentId, payerEmail, payerName } = req.body;
  const admin = createAdminClient();

  const { data: shipment } = await admin
    .from('shipments')
    .select('*')
    .eq('id', shipmentId)
    .single();

  if (!shipment || shipment.created_by !== user.sub) {
    res.status(StatusCodes.FORBIDDEN).json({ error: 'Envío no encontrado o sin permisos' });
    return;
  }

  const price = typeof shipment.price === 'number' ? shipment.price : null;
  if (price === null) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'El envío no tiene precio definido' });
    return;
  }

  try {
    const preference = await mpService.createPaymentPreference({
      shipmentId,
      title: shipment.title,
      amount: price,
      payerEmail,
      payerName,
      backUrls: {
        success: `${env.API_URL}/payments/success?shipment_id=${shipmentId}`,
        failure: `${env.API_URL}/payments/failure?shipment_id=${shipmentId}`,
        pending: `${env.API_URL}/payments/pending?shipment_id=${shipmentId}`,
      },
    });

    const commissionPercentage = parseFloat(env.COMMISSION_PERCENTAGE || '10');
    const commission = (price * commissionPercentage) / 100;

    const { data: paymentRecord, error: paymentError } = await admin
      .from('payments')
      .insert({
        shipment_id: shipmentId,
        payer_id: user.sub,
        status: 'pending',
        amount: price,
        commission_amount: commission,
        driver_amount: price - commission,
        preference_id: preference.preferenceId,
        payment_data: { sandbox_init_point: preference.sandboxInitPoint } as any,
      })
      .select('*')
      .single();

    if (paymentError) throw paymentError;

    res.status(StatusCodes.CREATED).json({
      ...preference,
      paymentId: paymentRecord.id,
      status: 'pending',
    });
  } catch (error) {
    logger.error('Error creando pago', error as Error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Error creando pago' });
  }
}));

/**
 * POST /payments/webhook
 */
router.post('/webhook', asyncHandler(async (req, res) => {
  const type = req.body.type || req.query.type;
  const dataId = req.body.data?.id || req.query.id;

  if ((type === 'payment' || type?.includes('payment')) && dataId) {
    const admin = createAdminClient();
    try {
      // Usar el SDK de MP (vía servicio) para obtener el pago
      // Nota: El servicio actual no tiene getPaymentById, lo añadiré si es necesario o usaré fetch
      const accessToken = env.MERCADOPAGO_ACCESS_TOKEN;
      const response = await fetch(`https://api.mercadopago.com/v1/payments/${dataId}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      
      if (response.ok) {
        const mpPayment = await response.json();
        const externalReference = mpPayment.external_reference;

        if (externalReference) {
          const { data: paymentRecord } = await admin
            .from('payments')
            .select('*')
            .eq('shipment_id', externalReference)
            .maybeSingle();

          if (paymentRecord) {
            const mpStatus = mpPayment.status;
            let dbStatus: any = 'pending';
            if (mpStatus === 'approved') dbStatus = 'approved';
            else if (['cancelled', 'rejected'].includes(mpStatus)) dbStatus = 'cancelled';

            const updateData: any = {
              status: dbStatus,
              payment_id: mpPayment.id.toString(),
              payment_data: { mp_payment: mpPayment } as any,
              updated_at: new Date().toISOString(),
            };

            if (dbStatus === 'approved' && !paymentRecord.paid_at) {
              updateData.paid_at = new Date().toISOString();
            }

            await admin.from('payments').update(updateData).eq('id', paymentRecord.id);

            if (dbStatus === 'approved' && paymentRecord.status !== 'approved') {
              await processApprovedPayment(paymentRecord, externalReference, admin);
            }
          }
        }
      }
    } catch (e) {
      logger.error('Error en webhook', e as Error);
    }
  }

  res.status(StatusCodes.OK).send('OK');
}));

/**
 * GET /payments/shipment/:shipmentId
 */
router.get('/shipment/:shipmentId', authMiddleware, asyncHandler(async (req, res) => {
  const { shipmentId } = req.params;
  const admin = createAdminClient();

  const { data: payment, error } = await admin
    .from('payments')
    .select('*, driver_transfers(*)')
    .eq('shipment_id', shipmentId)
    .maybeSingle();

  if (error || !payment) {
    res.status(StatusCodes.NOT_FOUND).json({ error: 'Pago no encontrado' });
    return;
  }

  res.json(payment);
}));

router.get('/success', (req, res) => res.redirect(`movi://payments/success?shipment_id=${req.query.shipment_id}`));
router.get('/failure', (req, res) => res.redirect(`movi://payments/failure?shipment_id=${req.query.shipment_id}`));
router.get('/pending', (req, res) => res.redirect(`movi://payments/pending?shipment_id=${req.query.shipment_id}`));

export const paymentRouter = router;
