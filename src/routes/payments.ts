import { Router } from 'express';
import { z } from 'zod';
import { createAdminClient } from '../lib/supabase';
import { createPaymentPreference, getPaymentById, calculatePaymentSplit } from '../lib/mercadopago';
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

// Aplicar middleware de autenticación a todas las rutas excepto webhook y redirects
import { authMiddleware } from '../middleware/auth';

// Función auxiliar para procesar pago aprobado (reutilizable)
async function processApprovedPayment(
  paymentRecord: any,
  externalReference: string,
  admin: ReturnType<typeof createAdminClient>
) {
  try {
    // Obtener información del envío
    const { data: shipment } = await admin
      .from('shipments')
      .select('id, title, current_status, pickup_address')
      .eq('id', externalReference)
      .single();

    if (shipment) {
      // Si el envío está en estado "draft", publicarlo (cambiar a "created")
      if (shipment.current_status === 'draft') {
        await admin
          .from('shipments')
          .update({ current_status: 'created' })
          .eq('id', shipment.id);

        logger.info('Envío publicado después de pago aprobado', {
          shipmentId: shipment.id,
          paymentId: paymentRecord.id,
        });

        // Notificar a drivers cercanos sobre el nuevo envío disponible
        try {
          // 1. Emitir evento por Broadcast (Realtime sin réplica)
          const shipmentChannel = admin.channel('global:shipments');
          await shipmentChannel.send({
            type: 'broadcast',
            event: 'new_shipment',
            payload: { shipmentId: shipment.id }
          });
          logger.info('Evento broadcast enviado para nuevo envío', { shipmentId: shipment.id });

          // 2. Obtener coordenadas de retiro del envío
          const parsedPickup = parseAddressWithCoordinates(shipment.pickup_address);
          let pickupLat: number | undefined = parsedPickup.lat;
          let pickupLng: number | undefined = parsedPickup.lng;

          if (!pickupLat || !pickupLng) {
            const coords = await geocodeAddress(parsedPickup.address);
            if (coords) {
              pickupLat = coords.lat;
              pickupLng = coords.lng;
            }
          }

          if (pickupLat && pickupLng) {
            // Obtener todos los drivers disponibles
            const { data: drivers } = await admin
              .from('profiles')
              .select('id, latitude, longitude, role, is_available')
              .eq('role', 'driver')
              .eq('is_available', true)
              .not('latitude', 'is', null)
              .not('longitude', 'is', null);

            if (drivers && drivers.length > 0) {
              // Filtrar drivers cercanos (dentro de 10km)
              const nearbyDrivers = filterNearbyUsers(
                drivers as any[],
                pickupLat,
                pickupLng,
                10
              );

              if (nearbyDrivers.length > 0) {
                const driverIds = nearbyDrivers.map(d => d.id);
                const { data: tokens } = await admin
                  .from('push_tokens')
                  .select('token')
                  .in('user_id', driverIds);

                const pushTokens = (tokens ?? []).map((t) => t.token);
                
                if (pushTokens.length > 0) {
                  await sendPush(
                    pushTokens,
                    'Nuevo envío disponible',
                    `${shipment.title} - Recoger en: ${parsedPickup.address}`
                  );
                  logger.info('Notificaciones enviadas a drivers cercanos', { 
                    shipmentId: shipment.id, 
                    driversCount: nearbyDrivers.length 
                  });
                }
              }
            }
          }
        } catch (notifyError) {
          logger.error('Error notificando a drivers después de publicar envío', notifyError as Error, { shipmentId: shipment.id });
        }
      }
    }

    // Notificar al usuario que pagó
    const { data: tokens } = await admin
      .from('push_tokens')
      .select('token')
      .eq('user_id', paymentRecord.payer_id);

    const pushTokens = (tokens ?? []).map((t) => t.token);
    if (pushTokens.length > 0) {
      await sendPush(
        pushTokens,
        'Pago aprobado',
        `Tu pago para el envío "${shipment?.title || 'Sin título'}" ha sido aprobado.`
      );
    }

    // Crear transferencia pendiente automáticamente si hay driver asignado
    try {
      const { data: assignment } = await admin
        .from('driver_assignments')
        .select('driver_id')
        .eq('shipment_id', externalReference)
        .maybeSingle();

      if (assignment && paymentRecord.driver_amount > 0) {
        // Vincular el driver_id al pago si hay una asignación
        await admin
          .from('payments')
          .update({ driver_id: assignment.driver_id })
          .eq('id', paymentRecord.id);

        // Verificar que no existe transferencia ya
        const { data: existingTransfer } = await (admin
          .from('driver_transfers' as any)
          .select('id')
          .eq('payment_id', paymentRecord.id)
          .maybeSingle() as any);

        if (!existingTransfer) {
          const { error: transferError } = await (admin
            .from('driver_transfers' as any)
            .insert({
              driver_id: assignment.driver_id,
              payment_id: paymentRecord.id,
              amount: paymentRecord.driver_amount,
              status: 'pending',
              transfer_method: 'manual',
              notes: 'Creada automáticamente al aprobarse el pago',
            }) as any);

          if (transferError) {
            logger.error('Error creando transferencia automática', transferError as Error, {
              paymentId: paymentRecord.id,
              driverId: assignment.driver_id,
            });
          } else {
            logger.info('Transferencia pendiente creada automáticamente', {
              paymentId: paymentRecord.id,
              driverId: assignment.driver_id,
              amount: paymentRecord.driver_amount,
            });
          }
        }
      }
    } catch (transferError) {
      logger.error('Error en proceso de transferencia automática', transferError as Error);
      // No fallamos el webhook si hay error en la transferencia
    }
  } catch (notifyError) {
    logger.error('Error notificando pago aprobado', notifyError as Error);
  }
}

// Schema para crear un pago
const CreatePaymentBody = z.object({
  shipmentId: z.string().uuid('ID de envío inválido'),
  payerEmail: z.string().email('Email inválido'),
  payerName: z.string().optional(),
});

// Schema para webhook de Mercado Pago
const WebhookBody = z.object({
  type: z.string(),
  data: z.object({
    id: z.string(),
  }),
});

/**
 * POST /payments/create
 * Crea una preferencia de pago para un envío
 * Solo usuarios business pueden crear pagos
 */
router.post('/create', validateBody(CreatePaymentBody), authMiddleware, asyncHandler(async (req, res) => {
  const user = req.user as { sub: string; role?: Role } | undefined;
  if (!user?.sub) {
    logger.warn('Intento de crear pago sin autenticación');
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  const { shipmentId, payerEmail, payerName } = req.body;
  const admin = createAdminClient();

  // Verificar que el usuario es business
  const { data: profile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', user.sub)
    .maybeSingle();

  if (!profile || profile.role !== 'business') {
    res.status(StatusCodes.FORBIDDEN).json({ 
      error: 'Solo usuarios business pueden crear pagos' 
    });
    return;
  }

  // Verificar que el envío existe y pertenece al usuario
  const { data: shipment, error: shipError } = await admin
    .from('shipments')
    .select('id, title, price, created_by, current_status')
    .eq('id', shipmentId)
    .single();

  if (shipError || !shipment) {
    logger.error('Error obteniendo envío', shipError as Error, { shipmentId });
    res.status(StatusCodes.NOT_FOUND).json({ error: 'Envío no encontrado' });
    return;
  }

  if (shipment.created_by !== user.sub) {
    res.status(StatusCodes.FORBIDDEN).json({ 
      error: 'No tienes permiso para crear un pago para este envío' 
    });
    return;
  }

  if (!shipment.price || shipment.price <= 0) {
    res.status(StatusCodes.BAD_REQUEST).json({ 
      error: 'El envío debe tener un precio válido' 
    });
    return;
  }

  // Verificar si ya existe un pago aprobado para este envío
  const { data: existingPayment } = await admin
    .from('payments')
    .select('id, status')
    .eq('shipment_id', shipmentId)
    .eq('status', 'approved')
    .maybeSingle();

  if (existingPayment) {
    res.status(StatusCodes.BAD_REQUEST).json({ 
      error: 'Ya existe un pago aprobado para este envío' 
    });
    return;
  }

  try {
    // Calcular split de pagos
    const split = calculatePaymentSplit(shipment.price);

    // Crear preferencia de pago en Mercado Pago
    const apiUrl = env.API_URL || process.env.API_URL || 'http://192.168.1.35:4000';
    const preference = await createPaymentPreference({
      shipmentId,
      title: shipment.title,
      amount: shipment.price,
      payerEmail,
      payerName: payerName || undefined,
      backUrls: {
        success: `${apiUrl}/payments/success?shipment_id=${shipmentId}`,
        failure: `${apiUrl}/payments/failure?shipment_id=${shipmentId}`,
        pending: `${apiUrl}/payments/pending?shipment_id=${shipmentId}`,
      },
    });

    // Guardar información del pago en la base de datos
    const { data: paymentRecord, error: paymentError } = await admin
      .from('payments')
      .insert({
        shipment_id: shipmentId,
        payer_id: user.sub,
        status: 'pending',
        amount: shipment.price,
        commission_amount: split.platformCommission,
        driver_amount: split.driverAmount,
        preference_id: preference.preferenceId?.toString() || null,
        payment_data: {
          sandbox_init_point: preference.sandboxInitPoint,
        },
      })
      .select('*')
      .single();

    if (paymentError) {
      logger.error('Error guardando pago en BD', paymentError as Error, { shipmentId });
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
        error: 'No se pudo guardar el pago' 
      });
      return;
    }

    logger.info('Preferencia de pago creada exitosamente', { 
      paymentId: paymentRecord.id, 
      shipmentId,
      preferenceId: preference.preferenceId,
      status: 'pending' // El pago aún está pendiente, solo se creó la preferencia
    });

    res.status(StatusCodes.CREATED).json({
      paymentId: paymentRecord.id,
      preferenceId: preference.preferenceId,
      initPoint: preference.initPoint,
      sandboxInitPoint: preference.sandboxInitPoint,
      checkoutUrl: preference.checkoutUrl, // URL correcta según entorno (sandbox o prod)
      status: 'pending', // Aclarar que el pago está pendiente
      message: 'Preferencia de pago creada. El pago estará pendiente hasta que se complete en Mercado Pago.',
    });
  } catch (error) {
    logger.error('Error creando pago', error as Error, { shipmentId });
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'No se pudo crear el pago' 
    });
  }
}));

/**
 * POST /payments/webhook
 * Webhook de Mercado Pago para notificar cambios en pagos
 * Maneja payment.created y payment.updated
 * CRITICAL: Este es la fuente de verdad para el estado del pago
 */
router.post('/webhook', asyncHandler(async (req, res) => {
  // Mercado Pago envía el webhook de diferentes formas según el tipo
  // Puede venir como query parameter o en el body
  const topic = req.query.topic as string || req.body.topic;
  const type = req.query.type as string || req.body.type;
  const resource = req.query.id as string || req.body.resource || req.body.data?.id;
  const data = req.query.data_id as string || req.body.data?.id || resource;

  // Manejar merchant_order (viene como query parameter)
  if (topic === 'merchant_order' && resource) {
    logger.info('Webhook merchant_order recibido', { merchantOrderId: resource });
    
    try {
      // Obtener la merchant_order desde la API de Mercado Pago
      const accessToken = env.MERCADOPAGO_ACCESS_TOKEN;
      if (!accessToken) {
        logger.error('MERCADOPAGO_ACCESS_TOKEN no configurado');
        res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Configuración incompleta' });
        return;
      }

      // Obtener merchant_order desde la URL del resource
      const merchantOrderUrl = typeof req.body.resource === 'string' 
        ? req.body.resource 
        : `https://api.mercadopago.com/merchant_orders/${resource}`;
      
      const merchantOrderResponse = await fetch(merchantOrderUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
        },
      });

      if (!merchantOrderResponse.ok) {
        logger.error('Error obteniendo merchant_order', new Error(await merchantOrderResponse.text()), {
          merchantOrderId: resource,
          status: merchantOrderResponse.status,
        });
        res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Error obteniendo merchant_order' });
        return;
      }

      const merchantOrder = await merchantOrderResponse.json();
      const externalReference = merchantOrder.external_reference;
      
      if (!externalReference) {
        logger.warn('Merchant order sin external_reference', { merchantOrderId: resource });
        res.status(StatusCodes.BAD_REQUEST).json({ error: 'Merchant order sin referencia' });
        return;
      }

      // Obtener los pagos asociados a la merchant_order
      const payments = merchantOrder.payments || [];
      
      if (payments.length === 0) {
        logger.debug('Merchant order sin pagos aún', { merchantOrderId: resource, shipmentId: externalReference });
        res.status(StatusCodes.OK).json({ ok: true, message: 'Merchant order sin pagos' });
        return;
      }

      // Procesar cada pago asociado
      const admin = createAdminClient();
      for (const paymentId of payments) {
        try {
          const payment = await getPaymentById(paymentId.toString());
          
          if (!payment) {
            logger.warn('Pago no encontrado en Mercado Pago', { paymentId });
            continue;
          }

          // Buscar el pago en nuestra base de datos
          let { data: paymentRecord } = await admin
            .from('payments')
            .select('*')
            .eq('shipment_id', externalReference)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (!paymentRecord) {
            logger.warn('Pago no encontrado en BD desde merchant_order', { 
              shipmentId: externalReference,
              mpPaymentId: payment.id,
            });
            continue;
          }

          // Actualizar estado del pago (reutilizar lógica existente)
          const mpStatus = payment.status || 'pending';
          let dbStatus: 'pending' | 'approved' | 'cancelled' | 'refunded' = 'pending';

          switch (mpStatus.toLowerCase()) {
            case 'approved':
            case 'accredited':
              dbStatus = 'approved';
              break;
            case 'cancelled':
            case 'canceled':
            case 'rejected':
            case 'declined':
              dbStatus = 'cancelled';
              break;
            case 'refunded':
            case 'refund':
              dbStatus = 'refunded';
              break;
            default:
              dbStatus = 'pending';
          }

          const updateData: any = {
            status: dbStatus,
            payment_id: payment.id?.toString(),
            payment_data: {
              ...(paymentRecord.payment_data && typeof paymentRecord.payment_data === 'object' ? paymentRecord.payment_data : {}),
              mp_payment: payment,
              merchant_order_id: resource,
            } as unknown as Json,
            updated_at: new Date().toISOString(),
          };

          if (dbStatus === 'approved' && !paymentRecord.paid_at) {
            updateData.paid_at = new Date().toISOString();
          }

          await admin
            .from('payments')
            .update(updateData)
            .eq('id', paymentRecord.id);

          logger.info('Pago actualizado desde merchant_order webhook', {
            paymentId: paymentRecord.id,
            shipmentId: externalReference,
            status: dbStatus,
            merchantOrderId: resource,
          });

          // Si el pago fue aprobado, procesar como en el webhook normal
          if (dbStatus === 'approved' && paymentRecord.status !== 'approved') {
            // Reutilizar la lógica de procesamiento de pago aprobado
            // Esta lógica está más abajo en el código, la llamamos aquí también
            await processApprovedPayment(paymentRecord, externalReference, admin);
          }
        } catch (paymentError) {
          logger.error('Error procesando pago desde merchant_order', paymentError as Error, {
            paymentId,
            merchantOrderId: resource,
          });
        }
      }

      res.status(StatusCodes.OK).json({ ok: true });
      return;
    } catch (error) {
      logger.error('Error procesando merchant_order webhook', error as Error, {
        merchantOrderId: resource,
      });
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Error procesando webhook' });
      return;
    }
  }

  // Manejar webhooks de tipo payment (formato estándar)
  if (!type || !data) {
    logger.warn('Webhook de Mercado Pago recibido sin tipo o data', { 
      body: req.body, 
      query: req.query,
      topic,
    });
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Datos inválidos' });
    return;
  }

  // Solo procesar payment.created y payment.updated
  if (type !== 'payment' && type !== 'payment.created' && type !== 'payment.updated') {
    logger.debug('Webhook ignorado (tipo no relevante)', { type, paymentId: data, topic });
    res.status(StatusCodes.OK).json({ ok: true, message: 'Tipo de webhook ignorado' });
    return;
  }

  logger.info('Webhook de Mercado Pago recibido', { type, paymentId: data });

  const admin = createAdminClient();

  try {
    // Obtener información del pago desde Mercado Pago
    const payment = await getPaymentById(data);

    if (!payment) {
      logger.warn('Pago no encontrado en Mercado Pago', { paymentId: data });
      res.status(StatusCodes.NOT_FOUND).json({ error: 'Pago no encontrado' });
      return;
    }

    const externalReference = payment.external_reference;
    if (!externalReference) {
      logger.warn('Pago sin external_reference', { paymentId: data });
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'Pago sin referencia' });
      return;
    }

    // Buscar el pago en nuestra base de datos
    // Primero intentar por shipment_id (external_reference)
    let { data: paymentRecord } = await admin
      .from('payments')
      .select('*')
      .eq('shipment_id', externalReference)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Si no se encuentra, intentar por payment_id
    if (!paymentRecord && payment.id) {
      const { data: paymentByMpId } = await admin
        .from('payments')
        .select('*')
        .eq('payment_id', payment.id.toString())
        .maybeSingle();
      paymentRecord = paymentByMpId;
    }

    // Si aún no se encuentra, intentar por preference_id si está disponible
    // Nota: preference_id puede venir en diferentes propiedades según la respuesta de MP
    const preferenceId = (payment as any).preference_id || (payment as any).preference?.id;
    if (!paymentRecord && preferenceId) {
      const { data: paymentByPrefId } = await admin
        .from('payments')
        .select('*')
        .eq('preference_id', preferenceId.toString())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      paymentRecord = paymentByPrefId;
    }

    if (!paymentRecord) {
      logger.warn('Pago no encontrado en BD', { 
        shipmentId: externalReference,
        mpPaymentId: payment.id,
        preferenceId: preferenceId || 'N/A'
      });
      res.status(StatusCodes.NOT_FOUND).json({ error: 'Pago no encontrado' });
      return;
    }

    // Actualizar estado del pago según el estado en Mercado Pago
    // Mercado Pago usa diferentes estados, mapeamos a nuestros estados
    const mpStatus = payment.status || 'pending';
    let dbStatus: 'pending' | 'approved' | 'cancelled' | 'refunded' = 'pending';

    switch (mpStatus.toLowerCase()) {
      case 'approved':
      case 'accredited':
        dbStatus = 'approved';
        break;
      case 'cancelled':
      case 'canceled':
      case 'rejected':
      case 'rejected':
      case 'declined':
        dbStatus = 'cancelled';
        break;
      case 'refunded':
      case 'refund':
        dbStatus = 'refunded';
        break;
      case 'pending':
      case 'in_process':
      case 'in_mediation':
      case 'charged_back':
      default:
        // Mantener como pending para estados intermedios
        dbStatus = 'pending';
    }

    logger.debug('Mapeo de estado de Mercado Pago', {
      mpStatus,
      dbStatus,
      paymentId: payment.id,
    });

    // Actualizar el pago en la base de datos
    const updateData: any = {
      status: dbStatus,
      payment_id: payment.id?.toString(),
      payment_data: {
        ...(paymentRecord.payment_data && typeof paymentRecord.payment_data === 'object' ? paymentRecord.payment_data : {}),
        mp_payment: payment,
      } as unknown as Json,
      updated_at: new Date().toISOString(),
    };

    // Si el pago fue aprobado y no tiene paid_at, establecerlo
    if (dbStatus === 'approved' && !paymentRecord.paid_at) {
      updateData.paid_at = new Date().toISOString();
    }

    await admin
      .from('payments')
      .update(updateData)
      .eq('id', paymentRecord.id);

    logger.info('Pago actualizado desde webhook', {
      paymentId: paymentRecord.id,
      shipmentId: externalReference,
      status: dbStatus,
    });

    // Si el pago fue aprobado, publicar el envío (cambiar de draft a created) y notificar
    if (dbStatus === 'approved' && paymentRecord.status !== 'approved') {
      await processApprovedPayment(paymentRecord, externalReference, admin);
    }

    res.status(StatusCodes.OK).json({ ok: true });
  } catch (error) {
    logger.error('Error procesando webhook de Mercado Pago', error as Error, {
      type,
      paymentId: data,
    });
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Error procesando webhook' });
  }
}));

/**
 * GET /payments/shipment/:shipmentId
 * Obtiene el estado del pago de un envío
 */
const GetPaymentParams = z.object({
  shipmentId: z.string().uuid('ID de envío inválido'),
});

router.get('/shipment/:shipmentId', validateParams(GetPaymentParams), authMiddleware, asyncHandler(async (req, res) => {
  const user = req.user as { sub: string } | undefined;
  if (!user?.sub) {
    logger.warn('Intento de obtener pago sin autenticación');
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  const { shipmentId } = req.params;
  const admin = createAdminClient();

  // Verificar que el usuario tiene acceso al envío
  const { data: shipment } = await admin
    .from('shipments')
    .select('id, created_by')
    .eq('id', shipmentId)
    .maybeSingle();

  if (!shipment) {
    res.status(StatusCodes.NOT_FOUND).json({ error: 'Envío no encontrado' });
    return;
  }

  // Verificar permisos: el dueño del envío o un driver asignado
  const { data: assignment } = await admin
    .from('driver_assignments')
    .select('driver_id')
    .eq('shipment_id', shipmentId)
    .maybeSingle();

  const isOwner = shipment.created_by === user.sub;
  const isDriver = assignment?.driver_id === user.sub;

  if (!isOwner && !isDriver) {
    res.status(StatusCodes.FORBIDDEN).json({ 
      error: 'No tienes permiso para ver este pago' 
    });
    return;
  }

  // Obtener el pago
  const { data: payment, error } = await admin
    .from('payments')
    .select(`
      *,
      driver_transfers (
        id,
        status,
        transferred_at,
        transfer_method,
        amount
      )
    `)
    .eq('shipment_id', shipmentId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.error('Error obteniendo pago', error as Error, { shipmentId });
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'No se pudo obtener el pago' 
    });
    return;
  }

  if (!payment) {
    res.status(StatusCodes.NOT_FOUND).json({ error: 'Pago no encontrado' });
    return;
  }

  // Si el pago no tiene driver_id pero existe una asignación, lo recuperamos
  // Esto corrige datos históricos y asegura que el frontend tenga el ID para transferencias
  if (!payment.driver_id) {
    const { data: assignment } = await admin
      .from('driver_assignments')
      .select('driver_id')
      .eq('shipment_id', shipmentId)
      .maybeSingle();
    
    if (assignment) {
      payment.driver_id = assignment.driver_id;
      // Actualizar en segundo plano para futuras consultas
      admin.from('payments').update({ driver_id: assignment.driver_id }).eq('id', payment.id).then(({ error: updateErr }) => {
        if (updateErr) logger.warn('Error actualizando driver_id faltante en pago', { error: updateErr, paymentId: payment.id });
      });
    }
  }

  // Ocultar información sensible si es el driver
  if (isDriver && !isOwner) {
    const { payer_id, payment_data, ...rest } = payment;
    res.json(rest);
  } else {
    res.json(payment);
  }
}));

/**
 * GET /payments/success, /payments/failure, /payments/pending
 * URLs de retorno después del pago (redirects)
 * Redirige a deep links de la app móvil para cerrar el WebView
 */
router.get('/success', asyncHandler(async (req, res) => {
  const shipmentId = req.query.shipment_id as string;
  
  // Redirigir a deep link de la app para cerrar el WebView
  // Usamos una página HTML que redirige automáticamente
  const deepLink = `movi://payments/success?shipment_id=${shipmentId}`;
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Pago exitoso</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
          }
          .container {
            text-align: center;
            padding: 2rem;
          }
          h1 { margin-bottom: 1rem; }
          p { opacity: 0.9; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>✅ Pago exitoso</h1>
          <p>Redirigiendo a la app...</p>
        </div>
        <script>
          (function() {
            const deepLink = '${deepLink}';
            
            // Función para intentar abrir el deep link
            function openDeepLink() {
              // Método 1: Intentar redirigir directamente
              try {
                window.location.href = deepLink;
              } catch (e) {
                console.error('Error redirigiendo:', e);
              }
              
              // Método 2: Intentar con window.open (para algunos navegadores)
              setTimeout(function() {
                try {
                  window.open(deepLink, '_self');
                } catch (e) {
                  console.error('Error con window.open:', e);
                }
              }, 100);
              
              // Método 3: Crear un link y hacer clic (más compatible)
              setTimeout(function() {
                try {
                  const link = document.createElement('a');
                  link.href = deepLink;
                  link.style.display = 'none';
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);
                } catch (e) {
                  console.error('Error con link.click:', e);
                }
              }, 200);
            }
            
            // Redirigir inmediatamente al deep link
            openDeepLink();
            
            // Fallback: si no funciona en unos segundos, mostrar mensaje
            setTimeout(function() {
              const container = document.querySelector('.container');
              if (container && !document.hidden) {
                container.innerHTML = 
                  '<h1>✅ Pago exitoso</h1><p>Por favor cierra esta ventana y regresa a la app.</p><p style="font-size: 12px; margin-top: 1rem;">Si la app no se abrió automáticamente, busca "Movi" en tus aplicaciones.</p>';
              }
            }, 3000);
          })();
        </script>
      </body>
    </html>
  `;
  
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
}));

router.get('/failure', asyncHandler(async (req, res) => {
  const shipmentId = req.query.shipment_id as string;
  
  const deepLink = `movi://payments/failure?shipment_id=${shipmentId}`;
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Pago fallido</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            color: white;
          }
          .container {
            text-align: center;
            padding: 2rem;
          }
          h1 { margin-bottom: 1rem; }
          p { opacity: 0.9; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>❌ Pago fallido</h1>
          <p>Redirigiendo a la app...</p>
        </div>
        <script>
          (function() {
            const deepLink = '${deepLink}';
            
            function openDeepLink() {
              try {
                window.location.href = deepLink;
              } catch (e) {
                console.error('Error redirigiendo:', e);
              }
              
              setTimeout(function() {
                try {
                  window.open(deepLink, '_self');
                } catch (e) {
                  console.error('Error con window.open:', e);
                }
              }, 100);
              
              setTimeout(function() {
                try {
                  const link = document.createElement('a');
                  link.href = deepLink;
                  link.style.display = 'none';
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);
                } catch (e) {
                  console.error('Error con link.click:', e);
                }
              }, 200);
            }
            
            // Redirigir inmediatamente al deep link
            openDeepLink();
            
            setTimeout(function() {
              const container = document.querySelector('.container');
              if (container && !document.hidden) {
                container.innerHTML = 
                  '<h1>❌ Pago fallido</h1><p>Por favor cierra esta ventana y regresa a la app.</p><p style="font-size: 12px; margin-top: 1rem;">Si la app no se abrió automáticamente, busca "Movi" en tus aplicaciones.</p>';
              }
            }, 3000);
          })();
        </script>
      </body>
    </html>
  `;
  
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
}));

router.get('/pending', asyncHandler(async (req, res) => {
  const shipmentId = req.query.shipment_id as string;
  
  const deepLink = `movi://payments/pending?shipment_id=${shipmentId}`;
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Pago pendiente</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #fad961 0%, #f76b1c 100%);
            color: white;
          }
          .container {
            text-align: center;
            padding: 2rem;
          }
          h1 { margin-bottom: 1rem; }
          p { opacity: 0.9; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>⏳ Pago pendiente</h1>
          <p>Redirigiendo a la app...</p>
        </div>
        <script>
          (function() {
            const deepLink = '${deepLink}';
            
            function openDeepLink() {
              try {
                window.location.href = deepLink;
              } catch (e) {
                console.error('Error redirigiendo:', e);
              }
              
              setTimeout(function() {
                try {
                  window.open(deepLink, '_self');
                } catch (e) {
                  console.error('Error con window.open:', e);
                }
              }, 100);
              
              setTimeout(function() {
                try {
                  const link = document.createElement('a');
                  link.href = deepLink;
                  link.style.display = 'none';
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);
                } catch (e) {
                  console.error('Error con link.click:', e);
                }
              }, 200);
            }
            
            // Redirigir inmediatamente al deep link
            openDeepLink();
            
            setTimeout(function() {
              const container = document.querySelector('.container');
              if (container && !document.hidden) {
                container.innerHTML = 
                  '<h1>⏳ Pago pendiente</h1><p>Por favor cierra esta ventana y regresa a la app.</p><p style="font-size: 12px; margin-top: 1rem;">Si la app no se abrió automáticamente, busca "Movi" en tus aplicaciones.</p>';
              }
            }, 3000);
          })();
        </script>
      </body>
    </html>
  `;
  
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
}));

export const paymentRouter = router;

