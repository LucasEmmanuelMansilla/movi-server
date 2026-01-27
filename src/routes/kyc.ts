// .env (variables de entorno)
// DIDIT_API_KEY=<tu API Key>
// DIDIT_WORKFLOW_ID=<UUID del flujo Didit configurado>
// DIDIT_WEBHOOK_SECRET=<Secret para verificar webhooks>

import express, { Router, Request, Response } from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { createAdminClient } from '../lib/supabase';
import { logger } from '../utils/logger';
import { StatusCodes } from 'http-status-codes';
import asyncHandler from 'express-async-handler';

const router = Router();

/**
 * Guarda el session_id de Didit en la base de datos para poder asociarlo con el usuario después
 */
async function saveSession(userId: string, sessionId: string, status: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from('profiles')
      .update({
        kyc_didit_session_id: sessionId,
        kyc_status: status,
      })
      .eq('id', userId);

    if (error) {
      logger.error('Error guardando sesión Didit', error as Error, { userId, sessionId });
      throw error;
    }
  } catch (error) {
    logger.error('Error en saveSession', error as Error, { userId, sessionId });
    throw error;
  }
}

/**
 * Busca el userId asociado a un session_id de Didit
 */
async function findUserIdBySession(sessionId: string): Promise<string | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('profiles')
      .select('id')
      .eq('kyc_didit_session_id', sessionId)
      .maybeSingle();

    if (error) {
      logger.error('Error buscando usuario por session_id', error as Error, { sessionId });
      return null;
    }

    return data?.id || null;
  } catch (error) {
    logger.error('Error en findUserIdBySession', error as Error, { sessionId });
    return null;
  }
}

/**
 * Marca al usuario como verificado (KYC aprobado)
 */
async function markUserAsVerified(userId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from('profiles')
      .update({
        kyc_status: 'approved',
        kyc_validated_at: new Date().toISOString(),
      })
      .eq('id', userId);

    if (error) {
      logger.error('Error marcando usuario como verificado', error as Error, { userId });
      throw error;
    }

    logger.info('Usuario marcado como verificado', { userId });
  } catch (error) {
    logger.error('Error en markUserAsVerified', error as Error, { userId });
    throw error;
  }
}

/**
 * Marca al usuario como rechazado (KYC rechazado)
 */
async function markUserAsRejected(userId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from('profiles')
      .update({
        kyc_status: 'declined',
      })
      .eq('id', userId);

    if (error) {
      logger.error('Error marcando usuario como rechazado', error as Error, { userId });
      throw error;
    }

    logger.info('Usuario marcado como rechazado', { userId });
  } catch (error) {
    logger.error('Error en markUserAsRejected', error as Error, { userId });
    throw error;
  }
}

/**
 * Notifica que el usuario está en revisión pendiente
 */
async function notifyUserPendingReview(userId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from('profiles')
      .update({
        kyc_status: 'in_review',
      })
      .eq('id', userId);

    if (error) {
      logger.error('Error actualizando estado a en revisión', error as Error, { userId });
      throw error;
    }

    logger.info('Usuario marcado como en revisión', { userId });
  } catch (error) {
    logger.error('Error en notifyUserPendingReview', error as Error, { userId });
    throw error;
  }
}

router.post('/start', asyncHandler(async (req: Request, res: Response) => {
  const userId = req.body.userId;  // Identificador del usuario que solicita verificación
  if (!userId) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Falta userId' });
    return;
  }

  // Verificar si el usuario ya tiene una sesión en proceso
  const admin = createAdminClient();
  const { data: existingProfile } = await admin
    .from('profiles')
    .select('kyc_status, kyc_didit_session_id')
    .eq('id', userId)
    .maybeSingle();

  // Si ya hay una sesión en revisión, no crear una nueva
  if (existingProfile?.kyc_status === 'in_review' && existingProfile?.kyc_didit_session_id) {
    logger.info('Usuario ya tiene sesión en proceso', { userId, sessionId: existingProfile.kyc_didit_session_id });
    res.status(StatusCodes.CONFLICT).json({ 
      error: 'Ya existe una verificación en proceso. Por favor, espera a que se complete.',
      code: 'VERIFICATION_IN_PROGRESS',
    });
    return;
  }

  // Preparar solicitud a Didit
  const diditPayload = {
    workflow_id: process.env.DIDIT_WORKFLOW_ID,
    vendor_data: String(userId),              // Identificar al usuario en Didit (string)
    // callback: 'myapp://didit-callback',    // Ejemplo de deep link de retorno (opcional)
    // metadata: { plan: 'premium' },        // Ejemplo de metadata opcional
    // contact_details: { email: ..., phone: ... }  // Opcional, si se requiere
  };

  try {
    const diditResponse = await axios.post(
      'https://verification.didit.me/v2/session/',
      diditPayload,
      {
        headers: { 'X-Api-Key': process.env.DIDIT_API_KEY }
      }
    );

    // Extraer la URL del flujo web de Didit
    const verificationUrl = diditResponse.data.url;
    const sessionId = diditResponse.data.session_id;
    const status = diditResponse.data.status || 'not_started';

    logger.info('Sesión Didit creada', {
      userId,
      sessionId,
      status,
      hasUrl: !!verificationUrl,
      urlPreview: verificationUrl ? verificationUrl.substring(0, 50) + '...' : 'sin URL',
    });

    // Validar que tengamos la URL
    if (!verificationUrl) {
      logger.error('Didit no devolvió URL en la respuesta', undefined, {
        userId,
        responseData: diditResponse.data,
      });
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
        error: 'No se recibió la URL de verificación de Didit',
      });
      return;
    }

    // Guardar session_id y estado en la base de datos
    if (sessionId) {
      await saveSession(userId, sessionId, status);
    }

    res.json({ url: verificationUrl });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
    const axiosError = error as any;
    const errorResponse = axiosError?.response?.data;
    const statusCode = axiosError?.response?.status;

    logger.error('Error creando sesion Didit', error as Error, {
      userId,
      statusCode,
      errorResponse: errorResponse || errorMessage,
    });

    // Manejar error 429 (rate limit) específicamente
    if (statusCode === 429) {
      const rateLimitMessage = errorResponse?.detail || 'Límite de solicitudes excedido. Por favor, espera un momento.';
      res.status(StatusCodes.TOO_MANY_REQUESTS).json({ 
        error: rateLimitMessage,
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfter: 60, // segundos
      });
      return;
    }

    // Otros errores
    res.status(statusCode || StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: errorResponse?.detail || errorResponse?.error || 'Error iniciando verificación de identidad',
      details: errorResponse,
    });
  }
}));

router.post('/api/webhook/didit', express.json({ type: '*/*' }), asyncHandler(async (req: Request, res: Response) => {
  // Didit envía la firma HMAC SHA256 en el header 'X-Signature' y un timestamp en 'X-Timestamp'
  const signatureHeader = req.headers['x-signature'];
  const timestampHeader = req.headers['x-timestamp'];
  
  // Los headers pueden ser string o string[], tomamos el primer valor si es array
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  const timestamp = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;
  
  if (!signature || !timestamp) {
    logger.warn('Webhook Didit rechazado: faltan headers de firma o timestamp');
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Faltan headers requeridos' });
    return;
  }

  const bodyString = JSON.stringify(req.body);
  const webhookSecret = process.env.DIDIT_WEBHOOK_SECRET;

  if (!webhookSecret) {
    logger.error('DIDIT_WEBHOOK_SECRET no configurado');
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Configuración del servidor incorrecta' });
    return;
  }

  // Verificar que el payload proviene de Didit calculando HMAC con nuestro WEBHOOK_SECRET
  const expectedSig = crypto
    .createHmac('sha256', webhookSecret)
    .update(timestamp + bodyString)
    .digest('hex');
    
  if (signature !== expectedSig) {
    logger.warn('Firma de webhook Didit no válida!', { signature, expectedSig: expectedSig.substring(0, 10) + '...' });
    res.status(StatusCodes.UNAUTHORIZED).end(); // Unauthorized - firma no coincide
    return;
  }

  // (Opcional) Verificar frescura del timestamp para evitar replays
  const FIVE_MIN = 5 * 60;
  const ageSeconds = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (ageSeconds > FIVE_MIN) {
    logger.warn('Webhook Didit desechado por timestamp (posible replay)', { ageSeconds });
    res.status(StatusCodes.BAD_REQUEST).end();
    return;
  }

  // Procesar el evento de verificación
  const event = req.body;
  // Por ejemplo, Didit puede enviar: { session_id, status, vendor_data, ... otros campos ... }
  logger.info('Webhook Didit recibido', { 
    sessionId: event.session_id, 
    status: event.status,
    vendorData: event.vendor_data 
  });

  // Identificar al usuario (usando vendor_data o buscando por session_id guardado)
  let userId: string | null = null;
  
  if (event.vendor_data) {
    userId = String(event.vendor_data);
  } else if (event.session_id) {
    userId = await findUserIdBySession(event.session_id);
  }

  if (!userId) {
    logger.warn('No se pudo determinar el usuario del evento Didit', { 
      sessionId: event.session_id,
      vendorData: event.vendor_data 
    });
    res.status(StatusCodes.OK).end(); // respondemos 200 igualmente
    return;
  }

  // Actualizar estado del usuario en base a event.status
  // Didit maneja estados intermedios: "Not Started", "In Progress", "In Review", 
  // y finales como "Approved", "Declined" o "Abandoned"
  try {
    if (event.status === 'Approved' || event.status === 'Completed') {
      await markUserAsVerified(userId);
    } else if (event.status === 'Declined') {
      await markUserAsRejected(userId);
    } else if (event.status === 'In Review') {
      await notifyUserPendingReview(userId);
    } else {
      // Actualizar el estado en la base de datos para otros estados
      const admin = createAdminClient();
      await admin
        .from('profiles')
        .update({
          kyc_status: event.status?.toLowerCase().replace(' ', '_') || null,
        })
        .eq('id', userId);
      
      logger.info('Estado KYC actualizado', { userId, status: event.status });
    }
  } catch (error) {
    logger.error('Error procesando webhook Didit', error as Error, { userId, status: event.status });
    // Respondemos 200 para que Didit no reintente, pero logueamos el error
  }

  res.status(StatusCodes.OK).end(); // Responder 200 OK al webhook
}));

export { router as kycRouter };
