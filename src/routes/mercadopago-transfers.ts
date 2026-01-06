import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createAdminClient } from '../lib/supabase';
import { transferToUser, refreshOAuthToken } from '../lib/mercadopago';
import { StatusCodes } from 'http-status-codes';
import asyncHandler from 'express-async-handler';
import { logger } from '../utils/logger';
import { validateBody, validateParams } from '../utils/validation';
import { authMiddleware } from '../middleware/auth';
import type { Role } from '../types';
import crypto from 'crypto';
import { env } from '../env';

const router = Router();

// Función para desencriptar tokens
function decryptToken(encryptedToken: string): string {
  const algorithm = 'aes-256-cbc';
  const key = crypto.scryptSync(env.SUPABASE_SERVICE_ROLE_KEY || 'default-key', 'salt', 32);
  const [ivHex, encrypted] = encryptedToken.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Función auxiliar para obtener y refrescar el access_token de un usuario si es necesario
 */
async function getValidAccessToken(userId: string): Promise<string | null> {
  const admin = createAdminClient();

  let profile: any = null;
  try {
    const result = await admin
      .from('profiles')
      .select('mp_access_token, mp_refresh_token, mp_token_expires_at, mp_status')
      .eq('id', userId)
      .maybeSingle();
    profile = result.data as any;
  } catch (selectError: any) {
    // Si hay error por campos que no existen
    if (selectError.code === '42703' || selectError.message?.includes('does not exist')) {
      return null;
    } else {
      throw selectError;
    }
  }

  if (!profile || profile.mp_status !== 'connected') {
    return null;
  }

  const encryptedAccessToken = profile.mp_access_token;
  const encryptedRefreshToken = profile.mp_refresh_token;
  const expiresAt = profile.mp_token_expires_at;

  if (!encryptedAccessToken) {
    return null;
  }

  // Verificar si el token está expirado
  let accessToken = decryptToken(encryptedAccessToken);
  const isExpired = expiresAt && new Date(expiresAt) < new Date();

  // Si está expirado, refrescar
  if (isExpired && encryptedRefreshToken) {
    try {
      const refreshToken = decryptToken(encryptedRefreshToken);
      const tokenResponse = await refreshOAuthToken(refreshToken);

      // Actualizar tokens en la BD
      const algorithm = 'aes-256-cbc';
      const key = crypto.scryptSync(env.SUPABASE_SERVICE_ROLE_KEY || 'default-key', 'salt', 32);
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv(algorithm, key, iv);
      let encrypted = cipher.update(tokenResponse.access_token, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      const newEncryptedAccessToken = iv.toString('hex') + ':' + encrypted;

      const iv2 = crypto.randomBytes(16);
      const cipher2 = crypto.createCipheriv(algorithm, key, iv2);
      let encrypted2 = cipher2.update(tokenResponse.refresh_token, 'utf8', 'hex');
      encrypted2 += cipher2.final('hex');
      const newEncryptedRefreshToken = iv2.toString('hex') + ':' + encrypted2;

      const expiresAtNew = new Date();
      expiresAtNew.setSeconds(expiresAtNew.getSeconds() + tokenResponse.expires_in);

      await admin
        .from('profiles')
        .update({
          mp_access_token: newEncryptedAccessToken,
          mp_refresh_token: newEncryptedRefreshToken,
          mp_token_expires_at: expiresAtNew.toISOString(),
          updated_at: new Date().toISOString(),
        } as any)
        .eq('id', userId);

      accessToken = tokenResponse.access_token;
      logger.info('Token refrescado automáticamente', { userId });
    } catch (error) {
      logger.error('Error refrescando token', error as Error, { userId });
      return null;
    }
  }

  return accessToken;
}

/**
 * POST /mp/transfers
 * Transfiere dinero a un usuario (driver) usando la API de Mercado Pago
 * Solo usuarios con rol 'business' o admin pueden realizar transferencias
 */
const CreateTransferBody = z.object({
  driver_id: z.string().uuid('ID de driver inválido'),
  amount: z.number().positive('El monto debe ser positivo'),
  description: z.string().min(1, 'La descripción es requerida').optional(),
  payment_id: z.string().uuid('ID de pago inválido').optional(), // Opcional: ID del pago relacionado
});

router.post('/', validateBody(CreateTransferBody), authMiddleware, asyncHandler(async (req, res) => {
  const user = req.user as { sub: string; role?: Role } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  const { driver_id, amount, description, payment_id } = req.body;

  try {
    const admin = createAdminClient();

    // Verificar permisos: solo business o admin pueden transferir
    const { data: requesterProfile } = await admin
      .from('profiles')
      .select('role')
      .eq('id', user.sub)
      .maybeSingle();

    if (!requesterProfile || (requesterProfile.role !== 'business' && requesterProfile.role !== 'admin')) {
      res.status(StatusCodes.FORBIDDEN).json({ 
        error: 'Solo usuarios business o admin pueden realizar transferencias' 
      });
      return;
    }

    // Obtener información del driver
    let driverProfile: any = null;
    try {
      const result = await admin
        .from('profiles')
        .select('id, mp_user_id, mp_status, role, full_name')
        .eq('id', driver_id)
        .maybeSingle();
      driverProfile = result.data as any;
    } catch (selectError: any) {
      // Si hay error por campos que no existen, intentar solo con campos básicos
      if (selectError.code === '42703' || selectError.message?.includes('does not exist')) {
        const result = await admin
          .from('profiles')
          .select('id, role, full_name')
          .eq('id', driver_id)
          .maybeSingle();
        driverProfile = result.data as any;
      } else {
        throw selectError;
      }
    }

    if (!driverProfile) {
      res.status(StatusCodes.NOT_FOUND).json({ error: 'Driver no encontrado' });
      return;
    }

    if (driverProfile.role !== 'driver') {
      res.status(StatusCodes.BAD_REQUEST).json({ 
        error: 'El usuario destino debe ser un driver' 
      });
      return;
    }

    const mpUserId = driverProfile.mp_user_id;
    const mpStatus = driverProfile.mp_status;

    if (!mpUserId || mpStatus !== 'connected') {
      res.status(StatusCodes.BAD_REQUEST).json({ 
        error: 'El driver no tiene Mercado Pago conectado. Debe conectar su cuenta primero.' 
      });
      return;
    }

    // Si hay un payment_id, verificar que existe y está aprobado
    if (payment_id) {
      const { data: payment } = await admin
        .from('payments')
        .select('id, status, driver_amount, shipment_id')
        .eq('id', payment_id)
        .maybeSingle();

      if (!payment) {
        res.status(StatusCodes.NOT_FOUND).json({ error: 'Pago no encontrado' });
        return;
      }

      if (payment.status !== 'approved') {
        res.status(StatusCodes.BAD_REQUEST).json({ 
          error: 'El pago debe estar aprobado para realizar la transferencia' 
        });
        return;
      }

      // Verificar que el driver del pago coincide
      const { data: assignment } = await admin
        .from('driver_assignments')
        .select('driver_id')
        .eq('shipment_id', payment.shipment_id)
        .maybeSingle();

      if (!assignment || assignment.driver_id !== driver_id) {
        res.status(StatusCodes.BAD_REQUEST).json({ 
          error: 'El driver no está asignado a este pago' 
        });
        return;
      }

      // Usar el driver_amount del pago si no se especificó amount
      if (!amount && payment.driver_amount) {
        // amount ya viene en el body, pero validamos que coincida
        if (Math.abs(amount - payment.driver_amount) > 0.01) {
          res.status(StatusCodes.BAD_REQUEST).json({ 
            error: `El monto debe ser ${payment.driver_amount} según el pago` 
          });
          return;
        }
      }
    }

    // Realizar transferencia usando el access_token del driver
    const transferDescription = description || 
      (payment_id ? `Pago por servicio - Payment ID: ${payment_id}` : `Transferencia a ${(driverProfile as any).full_name || 'driver'}`);

    const transferResult = await transferToUser({
      amount,
      driverUserId: parseInt(mpUserId),
      description: transferDescription,
      externalReference: payment_id || undefined,
    });

    logger.info('Transferencia realizada exitosamente', {
      transferId: transferResult.id,
      driverId: driver_id,
      amount,
      paymentId: payment_id,
    });

    // Si hay un payment_id, actualizar la transferencia en driver_transfers
    if (payment_id) {
      const { data: existingTransfer } = await (admin
        .from('driver_transfers' as any)
        .select('id')
        .eq('payment_id', payment_id)
        .maybeSingle() as any);

      if (existingTransfer) {
        // Actualizar transferencia existente
        await (admin
          .from('driver_transfers' as any)
          .update({
            status: 'completed',
            transferred_at: new Date().toISOString(),
            transfer_method: 'mercadopago',
            mp_transfer_id: transferResult.id.toString(),
            notes: `Transferencia realizada vía Mercado Pago. Transfer ID: ${transferResult.id}`,
          } as any)
          .eq('id', existingTransfer.id) as any);
      } else {
        // Crear nueva transferencia
        await (admin
          .from('driver_transfers' as any)
          .insert({
            driver_id: driver_id,
            payment_id: payment_id,
            amount: amount,
            status: 'completed',
            transfer_method: 'mercadopago',
            mp_transfer_id: transferResult.id.toString(),
            transferred_at: new Date().toISOString(),
            notes: `Transferencia realizada vía Mercado Pago. Transfer ID: ${transferResult.id}`,
          } as any) as any);
      }
    }

    res.status(StatusCodes.CREATED).json({
      success: true,
      transfer: {
        id: transferResult.id,
        amount: transferResult.amount,
        status: transferResult.status,
        date_created: transferResult.date_created,
        destination_user_id: transferResult.destination_user_id,
        description: transferResult.description,
      },
    });
  } catch (error: any) {
    logger.error('Error realizando transferencia', error as Error, {
      driverId: driver_id,
      amount,
      paymentId: payment_id,
    });

    // Manejar errores específicos de Mercado Pago
    if (error.message?.includes('insufficient_funds')) {
      res.status(StatusCodes.PAYMENT_REQUIRED).json({ 
        error: 'Fondos insuficientes en la cuenta del marketplace' 
      });
      return;
    }

    if (error.message?.includes('invalid_user')) {
      res.status(StatusCodes.BAD_REQUEST).json({ 
        error: 'Usuario de Mercado Pago inválido o no encontrado' 
      });
      return;
    }

    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'Error realizando transferencia',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
}));

/**
 * GET /mp/transfers/:transferId
 * Obtiene información de una transferencia por su ID
 */
const GetTransferParams = z.object({
  transferId: z.string(),
});

router.get('/:transferId', validateParams(GetTransferParams), authMiddleware, asyncHandler(async (req, res) => {
  const user = req.user as { sub: string; role?: Role } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  const { transferId } = req.params;

  try {
    // Por ahora, solo retornamos un mensaje indicando que se debe consultar directamente a Mercado Pago
    // En el futuro, podrías guardar las transferencias en una tabla propia
    res.status(StatusCodes.OK).json({
      message: 'Consulta la transferencia directamente en Mercado Pago',
      transfer_id: transferId,
      note: 'Las transferencias se realizan directamente en Mercado Pago. Para obtener detalles, consulta la API de Mercado Pago con el transfer_id.',
    });
  } catch (error) {
    logger.error('Error obteniendo transferencia', error as Error, { transferId });
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'Error obteniendo transferencia' 
    });
  }
}));

export const mercadoPagoTransfersRouter = router;
