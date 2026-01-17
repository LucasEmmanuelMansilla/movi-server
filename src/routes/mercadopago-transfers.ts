import { Router } from 'express';
import { z } from 'zod';
import { createAdminClient } from '../lib/supabase';
import { MercadoPagoService } from '../services/mercadopago.service';
import { TokenRepository } from '../repositories/token.repository';
import { StatusCodes } from 'http-status-codes';
import asyncHandler from 'express-async-handler';
import { logger } from '../utils/logger';
import { validateBody, validateParams } from '../utils/validation';
import { authMiddleware } from '../middleware/auth';

const router = Router();
const mpService = MercadoPagoService.getInstance();
const tokenRepo = TokenRepository.getInstance();

const CreateTransferBody = z.object({
  driver_id: z.string().uuid(),
  amount: z.number().positive(),
  description: z.string().optional(),
  payment_id: z.string().uuid().optional(),
});

/**
 * POST /mp/transfers
 * Realiza una transferencia manual al driver usando Advanced Payments
 */
router.post('/', validateBody(CreateTransferBody), authMiddleware, asyncHandler(async (req, res) => {
  const user = req.user;
  if (user?.role !== 'admin') {
    res.status(StatusCodes.FORBIDDEN).json({ error: 'Solo administradores pueden transferir' });
    return;
  }

  const { driver_id, amount, description, payment_id } = req.body;
  const admin = createAdminClient();

  try {
    // 1. Obtener info del driver y su mp_user_id
    const { data: profile } = await admin
      .from('profiles')
      .select('mp_user_id, mp_status, full_name, mp_refresh_token, mp_token_expires_at')
      .eq('id', driver_id)
      .single();

    if (!profile || profile.mp_status !== 'connected' || !profile.mp_user_id) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'El driver no tiene Mercado Pago conectado' });
      return;
    }

    // 2. Verificar si el token está expirado y refrescarlo si es necesario
    const expiresAt = profile.mp_token_expires_at;
    const isExpired = expiresAt ? new Date(expiresAt) < new Date() : false;

    if (isExpired && profile.mp_refresh_token) {
      logger.info('Token de MP expirado para driver, intentando refrescar', { driver_id });
      try {
        const refreshToken = tokenRepo.decrypt(profile.mp_refresh_token);
        const tokenResponse = await mpService.refreshOAuthToken(refreshToken);

        const newExpiresAt = new Date();
        newExpiresAt.setSeconds(newExpiresAt.getSeconds() + tokenResponse.expires_in);

        await admin
          .from('profiles')
          .update({
            mp_access_token: tokenRepo.encrypt(tokenResponse.access_token),
            mp_refresh_token: tokenRepo.encrypt(tokenResponse.refresh_token),
            mp_token_expires_at: newExpiresAt.toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', driver_id);
        
        logger.info('Token de MP refrescado exitosamente para driver', { driver_id });
      } catch (refreshError) {
        logger.error('Error refrescando token de MP para transferencia', refreshError as Error);
        res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
          error: 'Error de conexión con Mercado Pago del driver (token expirado y fallo al refrescar)' 
        });
        return;
      }
    }

    // 3. Ejecutar transferencia vía servicio
    const transferResult = await mpService.transferToUser({
      collectorId: profile.mp_user_id,
      amount,
      externalReference: payment_id || `transfer_${Date.now()}`,
      description: description || `Pago a ${profile.full_name}`,
    });

    // 4. Registrar en driver_transfers
    const { data: transferRecord } = await admin
      .from('driver_transfers' as any)
      .insert({
        driver_id,
        payment_id,
        amount,
        status: 'completed',
        transfer_method: 'mercadopago',
        mp_transfer_id: transferResult.id?.toString(),
        transferred_at: new Date().toISOString(),
      } as any)
      .select()
      .single();

    res.status(StatusCodes.CREATED).json({ success: true, transfer: transferRecord });
  } catch (error: any) {
    logger.error('Error en transferencia Mercado Pago', error as Error, {
      driver_id,
      amount
    });
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'Error procesando transferencia',
      details: error.message 
    });
  }
}));

export const mercadoPagoTransfersRouter = router;
