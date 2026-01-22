import { Router } from 'express';
import express from 'express';
import { z } from 'zod';
import { createAdminClient } from '../lib/supabase';
import { StatusCodes } from 'http-status-codes';
import asyncHandler from 'express-async-handler';
import { logger } from '../utils/logger';
import { authMiddleware } from '../middleware/auth';
import { diditService, KYCStatus } from '../services/didit.service';
import { validateBody } from '../utils/validation';

const router = Router();

/**
 * POST /kyc/init
 * Inicializa una sesión de validación KYC con Didit
 */
router.post(
  '/init',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const user = req.user as { sub: string; email?: string } | undefined;
    if (!user?.sub) {
      res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Unauthorized' });
      return;
    }

    const admin = createAdminClient();

    try {
      // Verificar que el usuario sea driver (business no requiere KYC)
      const { data: profile } = await admin
        .from('profiles')
        .select('role, kyc_status, email, kyc_didit_session_id')
        .eq('id', user.sub)
        .maybeSingle();

      if (!profile) {
        res.status(StatusCodes.NOT_FOUND).json({ error: 'Profile not found' });
        return;
      }

      if (profile.role !== 'driver') {
        res.status(StatusCodes.FORBIDDEN).json({
          error: 'KYC validation is only required for drivers',
        });
        return;
      }

      // Si ya está aprobado, no necesita nueva validación
      if (profile.kyc_status === 'approved') {
        res.status(StatusCodes.OK).json({
          message: 'KYC already approved',
          status: 'approved',
        });
        return;
      }

      // Si ya tiene una sesión en progreso, intentar recuperarla o verificarla
      if (profile.kyc_didit_session_id && profile.kyc_status === 'in_progress') {
        try {
          const diditData = await diditService.getVerificationStatus(profile.kyc_didit_session_id);
          
          // Si la sesión no ha fallado ni expirado, podemos reusarla
          if (diditData.status !== 'failed' && diditData.status !== 'expired') {
             res.status(StatusCodes.OK).json({
                session_id: profile.kyc_didit_session_id,
                verification_url: (diditData as any).url || `https://verification.didit.me/v3/session/${profile.kyc_didit_session_id}`, // Reconstruir si no viene (usar v3)
                status: 'in_progress',
             });
             return;
          }
        } catch (e) {
          logger.warn('No se pudo recuperar sesión existente, creando nueva', { userId: user.sub });
        }
      }

      // Crear sesión en Didit
      const session = await diditService.createVerificationSession(
        user.sub,
        profile.email || user.email
      );

      // Actualizar perfil con session_id y estado
      const { error: updateError } = await admin
        .from('profiles')
        .update({
          kyc_didit_session_id: session.session_id,
          kyc_status: 'in_progress',
          updated_at: new Date().toISOString(),
        })
        .eq('id', user.sub);

      if (updateError) {
        logger.error('Error actualizando perfil con session_id', updateError as Error, {
          userId: user.sub,
        });
        throw new Error('Failed to update profile with session ID');
      }

      logger.info('Sesión KYC iniciada', {
        userId: user.sub,
        sessionId: session.session_id,
      });

      res.status(StatusCodes.OK).json({
        session_id: session.session_id,
        verification_url: session.url,
        status: 'in_progress',
      });
    } catch (error: any) {
      logger.error('Error iniciando KYC', error as Error, { userId: user.sub });
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        error: 'Failed to initialize KYC verification',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  })
);

/**
 * GET /kyc/status
 * Obtiene el estado actual de la validación KYC del usuario
 */
router.get(
  '/status',
  authMiddleware,
  asyncHandler(async (req, res) => {
    const user = req.user as { sub: string } | undefined;
    if (!user?.sub) {
      res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Unauthorized' });
      return;
    }

    const admin = createAdminClient();

    try {
      const { data: profile, error: profileError } = await admin
        .from('profiles')
        .select(
          'role, kyc_status, kyc_didit_session_id, kyc_validated_at, kyc_document_number, kyc_document_type, kyc_first_name, kyc_last_name, kyc_birth_date, kyc_nationality'
        )
        .eq('id', user.sub)
        .maybeSingle();

      if (profileError) {
        throw profileError;
      }

      if (!profile) {
        res.status(StatusCodes.NOT_FOUND).json({ error: 'Profile not found' });
        return;
      }

      // Si hay una sesión activa, verificar estado en Didit
      // Consultar Didit siempre que haya session_id, excepto si ya está approved
      // Esto permite sincronizar estados que pueden haber cambiado en Didit
      let currentStatus: KYCStatus = (profile.kyc_status as KYCStatus) || 'pending';
      let verificationData = null;

      // Consultar Didit si hay session_id y el estado no es 'approved'
      // Esto incluye casos donde el estado es null, 'pending', 'in_progress', o 'rejected'
      if (profile.kyc_didit_session_id && profile.kyc_status !== 'approved') {
        try {
          logger.info('Consultando estado en Didit para sincronización', {
            userId: user.sub,
            sessionId: profile.kyc_didit_session_id,
            currentStatus: profile.kyc_status,
          });

          const diditData = await diditService.getVerificationStatus(
            profile.kyc_didit_session_id
          );
          
          const diditStatus = diditService.mapDiditStatusToKYCStatus(
            diditData.status,
            diditData.verification_result?.overall_status
          );

          logger.info('Estado recibido de Didit', {
            userId: user.sub,
            sessionId: profile.kyc_didit_session_id,
            diditStatus: diditData.status,
            diditOverallStatus: diditData.verification_result?.overall_status,
            mappedStatus: diditStatus,
            currentDbStatus: profile.kyc_status,
          });

          // Si cambió el estado, actualizar en la base de datos
          if (diditStatus !== profile.kyc_status) {
            logger.info('Estado KYC cambió, actualizando en DB', {
              userId: user.sub,
              sessionId: profile.kyc_didit_session_id,
              oldStatus: profile.kyc_status,
              newStatus: diditStatus,
            });

            const updateData: any = {
              kyc_status: diditStatus,
              updated_at: new Date().toISOString(),
            };

            // Si fue aprobado, guardar datos extraídos
            if (diditStatus === 'approved' && diditData.verification_result) {
              const doc = diditData.verification_result.document;
              const extracted = doc?.extracted_data;

              updateData.kyc_validated_at = new Date().toISOString();
              if (doc?.type) updateData.kyc_document_type = doc.type;
              if (doc?.number) updateData.kyc_document_number = doc.number;
              if (extracted?.first_name) updateData.kyc_first_name = extracted.first_name;
              if (extracted?.last_name) updateData.kyc_last_name = extracted.last_name;
              if (extracted?.birth_date) updateData.kyc_birth_date = extracted.birth_date;
              if (extracted?.nationality) updateData.kyc_nationality = extracted.nationality;

              logger.info('KYC aprobado, guardando datos extraídos', {
                userId: user.sub,
                sessionId: profile.kyc_didit_session_id,
                documentType: doc?.type,
                documentNumber: doc?.number,
              });
            }

            await admin.from('profiles').update(updateData).eq('id', user.sub);
            currentStatus = diditStatus;
          } else {
            // Aunque no cambió, usar el estado de Didit para asegurar consistencia
            currentStatus = diditStatus;
            logger.info('Estado KYC sin cambios, usando estado de Didit', {
              userId: user.sub,
              sessionId: profile.kyc_didit_session_id,
              status: diditStatus,
            });
          }

          verificationData = diditData.verification_result;
        } catch (error: any) {
          logger.error('Error consultando estado en Didit', error as Error, {
            sessionId: profile.kyc_didit_session_id,
            userId: user.sub,
            currentStatus: profile.kyc_status,
          });
          // Continuar con el estado guardado en DB si falla la consulta
        }
      } else if (profile.kyc_didit_session_id && profile.kyc_status === 'approved') {
        // Si ya está approved, no consultar Didit para evitar llamadas innecesarias
        // pero loguear para debugging
        logger.info('KYC ya está aprobado, omitiendo consulta a Didit', {
          userId: user.sub,
          sessionId: profile.kyc_didit_session_id,
        });
      }

      res.status(StatusCodes.OK).json({
        status: currentStatus,
        session_id: profile.kyc_didit_session_id,
        validated_at: profile.kyc_validated_at,
        document_number: profile.kyc_document_number,
        document_type: profile.kyc_document_type,
        first_name: profile.kyc_first_name,
        last_name: profile.kyc_last_name,
        birth_date: profile.kyc_birth_date,
        nationality: profile.kyc_nationality,
        verification_data: verificationData,
      });
    } catch (error: any) {
      logger.error('Error obteniendo estado KYC', error as Error, { userId: user.sub });
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        error: 'Failed to get KYC status',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  })
);

const WebhookBody = z.object({
  event_type: z.string().optional(), // Según la guía, puede venir event_type: 'session.completed'
  session_id: z.string(),
  status: z.string(),
  verification_result: z
    .object({
      overall_status: z.enum(['approved', 'rejected', 'pending']).optional(),
      document: z
        .object({
          type: z.string().optional(),
          number: z.string().optional(),
          extracted_data: z
            .object({
              first_name: z.string().optional(),
              last_name: z.string().optional(),
              birth_date: z.string().optional(),
              nationality: z.string().optional(),
            })
            .optional(),
        })
        .optional(),
      face_match: z
        .object({
          result: z.enum(['match', 'no_match', 'failed']).optional(),
          confidence: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
  vendor_data: z.string().optional(),
});

/**
 * GET /kyc/webhook
 * Maneja la redirección del usuario después de completar la verificación en el WebView
 */
router.get(
  '/webhook',
  asyncHandler(async (req, res) => {
    const { status, vendor_data, verificationSessionId } = req.query;

    logger.info('Usuario redirigido desde Didit', {
      status,
      vendor_data,
      verificationSessionId,
    });

    // Devolver una página HTML que notifica a la app
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Verificación en Proceso</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { 
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; 
              display: flex; 
              flex-direction: column; 
              align-items: center; 
              justify-content: center; 
              height: 100vh; 
              margin: 0; 
              text-align: center; 
              padding: 20px;
              background-color: #f8f9fa;
            }
            .container {
              background: white;
              padding: 30px;
              border-radius: 16px;
              box-shadow: 0 4px 6px rgba(0,0,0,0.1);
              max-width: 300px;
            }
            h1 { color: #2ecc71; font-size: 24px; margin-bottom: 10px; }
            p { color: #6c757d; font-size: 16px; line-height: 1.5; }
            .loader {
              border: 4px solid #f3f3f3;
              border-top: 4px solid #2ecc71;
              border-radius: 50%;
              width: 40px;
              height: 40px;
              animation: spin 1s linear infinite;
              margin: 20px auto;
            }
            @keyframes spin {
              0% { transform: rotate(0deg); }
              100% { transform: rotate(360deg); }
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>¡Pasos completados!</h1>
            <div class="loader"></div>
            <p>Estamos validando tus fotos. Serás redirigido automáticamente en unos segundos.</p>
          </div>
          <script>
            // Notificar al WebView de React Native inmediatamente
            function notifyApp() {
              if (window.ReactNativeWebView) {
                window.ReactNativeWebView.postMessage(JSON.stringify({
                  type: 'KYC_COMPLETED',
                  status: '${status || 'completed'}',
                  userId: '${vendor_data || ''}'
                }));
              }
            }

            // Reintentar notificar por si el WebView no está listo
            notifyApp();
            setTimeout(notifyApp, 500);
            setTimeout(notifyApp, 2000);
            
            // Si después de 5 segundos no pasó nada, intentar cerrar
            setTimeout(function() {
              window.close();
            }, 5000);
          </script>
        </body>
      </html>
    `);
  })
);

// Router separado para el webhook que necesita body crudo
// Este router se registra ANTES del middleware express.json() en index.ts
const webhookRouter = Router();

/**
 * POST /kyc/webhook
 * Webhook público para recibir notificaciones de Didit
 * No requiere autenticación, pero debe validarse la firma del webhook
 * 
 * IMPORTANTE: Este endpoint debe validar la firma HMAC SHA256 según la guía de Didit.
 * 
 * La validación se hace con: HMAC SHA256(timestamp + payload) usando WEBHOOK_SECRET_KEY
 * 
 * NOTA: Este router se registra ANTES del middleware express.json() en index.ts
 * para poder obtener el body crudo y validar correctamente la firma.
 */
webhookRouter.post(
  '/webhook',
  // Middleware para obtener body crudo (necesario para validar signature)
  express.raw({ type: 'application/json' }),
  asyncHandler(async (req, res) => {
    try {
      // Obtener headers según la guía: X-Signature y X-Timestamp
      const signature = (req.headers['x-signature'] || req.headers['x-didit-signature']) as string;
      const timestamp = req.headers['x-timestamp'] as string;
      
      // El body viene como Buffer cuando usamos express.raw()
      const payload = req.body instanceof Buffer 
        ? req.body.toString('utf8')
        : typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body);

      // Validar firma del webhook según la guía
      if (!diditService.validateWebhookSignature(payload, signature || '', timestamp || '')) {
        logger.warn('Webhook de Didit con firma inválida', { 
          hasSignature: !!signature,
          hasTimestamp: !!timestamp,
        });
        res.status(StatusCodes.FORBIDDEN).json({ error: 'Firma inválida' });
        return;
      }

      // Parsear el payload JSON
      let event;
      try {
        event = JSON.parse(payload);
      } catch (parseError) {
        logger.warn('Webhook de Didit con payload JSON inválido', { payload: payload.substring(0, 100) });
        res.status(StatusCodes.BAD_REQUEST).json({ error: 'Invalid JSON payload' });
        return;
      }

      const parsed = WebhookBody.safeParse(event);
      if (!parsed.success) {
        logger.warn('Webhook de Didit con formato inválido', {
          errors: parsed.error.errors,
        });
        res.status(StatusCodes.BAD_REQUEST).json({
          error: 'Invalid webhook payload',
          details: parsed.error.flatten(),
        });
        return;
      }

      const { event_type, session_id, status, verification_result, vendor_data } = parsed.data;

      // Procesar todos los eventos relevantes, no solo session.completed
      // Eventos que debemos procesar:
      // - session.completed: sesión completada
      // - session.updated: sesión actualizada (cambios de estado)
      // - session.failed: sesión fallida
      // - session.expired: sesión expirada
      // - Cualquier evento con status que indique un cambio
      const relevantEvents = [
        'session.completed',
        'session.updated',
        'session.failed',
        'session.expired',
        'verification.completed',
        'verification.updated',
      ];
      
      const isRelevantEvent = 
        event_type && relevantEvents.includes(event_type) ||
        status && (status === 'completed' || status === 'finished' || status === 'failed' || status === 'expired');

      logger.info('Webhook de Didit recibido', {
        event_type,
        session_id,
        status,
        isRelevantEvent,
        hasVerificationResult: !!verification_result,
      });

      if (!vendor_data) {
        logger.warn('Webhook de Didit sin vendor_data', { session_id, event_type });
        res.status(StatusCodes.BAD_REQUEST).json({ error: 'Missing vendor_data' });
        return;
      }

      const userId = vendor_data;
      const admin = createAdminClient();

      // Verificar que la sesión pertenece al usuario
      const { data: profile } = await admin
        .from('profiles')
        .select('id, kyc_didit_session_id, kyc_status')
        .eq('id', userId)
        .eq('kyc_didit_session_id', session_id)
        .maybeSingle();

      if (!profile) {
        logger.warn('Webhook de Didit para sesión no encontrada', {
          session_id,
          userId,
          event_type,
        });
        res.status(StatusCodes.NOT_FOUND).json({ error: 'Session not found' });
        return;
      }

      // Mapear estado de Didit a nuestro formato
      const kycStatus: KYCStatus = diditService.mapDiditStatusToKYCStatus(
        status,
        verification_result?.overall_status
      );

      logger.info('Webhook de Didit procesando', {
        event_type,
        session_id,
        status,
        diditOverallStatus: verification_result?.overall_status,
        mappedKycStatus: kycStatus,
        currentDbStatus: profile.kyc_status,
        userId,
      });

      // Procesar el webhook y actualizar el estado
      // Actualizar siempre que haya un cambio de estado, no solo en eventos de completado
      const shouldUpdate = 
        kycStatus !== profile.kyc_status || // El estado cambió
        isRelevantEvent || // Es un evento relevante
        verification_result; // Hay datos de verificación

      if (!shouldUpdate) {
        logger.info('Webhook de Didit recibido pero no requiere actualización', {
          userId,
          session_id,
          event_type,
          status,
          currentStatus: profile.kyc_status,
          mappedStatus: kycStatus,
        });
        res.status(StatusCodes.OK).json({ success: true, message: 'No update needed' });
        return;
      }

      // Preparar datos de actualización
      const updateData: any = {
        kyc_status: kycStatus,
        updated_at: new Date().toISOString(),
      };

      // Si fue aprobado, guardar datos extraídos
      if (kycStatus === 'approved' && verification_result) {
        const doc = verification_result.document;
        const extracted = doc?.extracted_data;

        updateData.kyc_validated_at = new Date().toISOString();
        if (doc?.type) updateData.kyc_document_type = doc.type;
        if (doc?.number) updateData.kyc_document_number = doc.number;
        if (extracted?.first_name) updateData.kyc_first_name = extracted.first_name;
        if (extracted?.last_name) updateData.kyc_last_name = extracted.last_name;
        if (extracted?.birth_date) updateData.kyc_birth_date = extracted.birth_date;
        if (extracted?.nationality) updateData.kyc_nationality = extracted.nationality;

        logger.info('KYC aprobado desde webhook, guardando datos extraídos', {
          userId,
          session_id,
          documentType: doc?.type,
          documentNumber: doc?.number,
        });
      }

      // Actualizar perfil
      const { error: updateError } = await admin
        .from('profiles')
        .update(updateData)
        .eq('id', userId);

      if (updateError) {
        logger.error('Error actualizando perfil desde webhook', updateError as Error, {
          userId,
          session_id,
          event_type,
          kycStatus,
        });
        throw new Error('Failed to update profile from webhook');
      }

      logger.info('Perfil actualizado desde webhook de Didit', {
        userId,
        session_id,
        event_type,
        oldStatus: profile.kyc_status,
        newStatus: kycStatus,
        hasVerificationResult: !!verification_result,
      });

      res.status(StatusCodes.OK).json({ success: true });
    } catch (error: any) {
      logger.error('Error procesando webhook de Didit', error as Error);
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        error: 'Failed to process webhook',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  })
);

export const kycRouter = router;
export const kycWebhookRouter = webhookRouter;
