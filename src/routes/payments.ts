import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createAdminClient } from '../lib/supabase';
import { createPaymentPreference, getPaymentById, calculatePaymentSplit, isPaymentApproved } from '../lib/mercadopago';
import { StatusCodes } from 'http-status-codes';
import asyncHandler from 'express-async-handler';
import { logger } from '../utils/logger';
import { validateBody, validateParams, validateQuery } from '../utils/validation';
import type { Role } from '../types';
import { sendPush } from './push';
import type { Payment } from '../types/payments';
import type { Json } from '../supabase.types';
import { env } from '../env';

const router = Router();

// Aplicar middleware de autenticación a todas las rutas excepto webhook y redirects
import { authMiddleware } from '../middleware/auth';

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
  const type = req.query.type as string || req.body.type;
  const data = req.query.data_id as string || req.body.data?.id;

  if (!type || !data) {
    logger.warn('Webhook de Mercado Pago recibido sin tipo o data', { 
      body: req.body, 
      query: req.query 
    });
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Datos inválidos' });
    return;
  }

  // Solo procesar payment.created y payment.updated
  if (type !== 'payment' && type !== 'payment.created' && type !== 'payment.updated') {
    logger.debug('Webhook ignorado (tipo no relevante)', { type, paymentId: data });
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

    // Si el pago fue aprobado, notificar al usuario y crear transferencia pendiente
    if (dbStatus === 'approved' && paymentRecord.status !== 'approved') {
      try {
        const { data: shipment } = await admin
          .from('shipments')
          .select('title')
          .eq('id', externalReference)
          .single();

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
    .select('*')
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
            
            // Detectar si estamos en la página de advertencia de ngrok (solo en desarrollo)
            // En producción, esto nunca debería ser true
            const isNgrokWarning = window.location.hostname.includes('ngrok') && (
              document.body.textContent.includes('You are about to visit') || 
              document.body.textContent.includes('ngrok') ||
              document.querySelector('a[href*="ngrok"]') !== null
            );
            
            if (isNgrokWarning) {
              // Buscar el botón "Visit Site" y hacer clic automáticamente
              const visitButton = document.querySelector('button, a[href*="visit"], [onclick*="visit"], a[class*="button"]');
              if (visitButton) {
                // Esperar a que se cargue completamente y hacer clic
                setTimeout(function() {
                  visitButton.click();
                  // Después de hacer clic, esperar un momento y redirigir al deep link
                  setTimeout(openDeepLink, 1000);
                }, 500);
                return;
              }
              
              // Si no encontramos el botón, intentar redirigir directamente
              setTimeout(openDeepLink, 500);
              return;
            }
            
            // Si no estamos en ngrok, redirigir inmediatamente al deep link
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
            
            const isNgrokWarning = document.body.textContent.includes('You are about to visit') || 
                                   document.body.textContent.includes('ngrok') ||
                                   document.querySelector('a[href*="ngrok"]') !== null;
            
            if (isNgrokWarning) {
              const visitButton = document.querySelector('button, a[href*="visit"], [onclick*="visit"], a[class*="button"]');
              if (visitButton) {
                setTimeout(function() {
                  visitButton.click();
                  setTimeout(openDeepLink, 1000);
                }, 500);
                return;
              }
              setTimeout(openDeepLink, 500);
              return;
            }
            
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
            
            const isNgrokWarning = document.body.textContent.includes('You are about to visit') || 
                                   document.body.textContent.includes('ngrok') ||
                                   document.querySelector('a[href*="ngrok"]') !== null;
            
            if (isNgrokWarning) {
              const visitButton = document.querySelector('button, a[href*="visit"], [onclick*="visit"], a[class*="button"]');
              if (visitButton) {
                setTimeout(function() {
                  visitButton.click();
                  setTimeout(openDeepLink, 1000);
                }, 500);
                return;
              }
              setTimeout(openDeepLink, 500);
              return;
            }
            
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

