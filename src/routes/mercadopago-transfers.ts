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
    const { data: driver } = await admin
      .from('profiles')
      .select('mp_user_id, mp_status, full_name')
      .eq('id', driver_id)
      .single();

    if (!driver || driver.mp_status !== 'connected' || !driver.mp_user_id) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'El driver no tiene Mercado Pago conectado' });
      return;
    }

    // 2. Ejecutar transferencia vía servicio
    const transferResult = await mpService.transferToUser({
      collectorId: driver.mp_user_id,
      amount,
      externalReference: payment_id || `transfer_${Date.now()}`,
      description: description || `Pago a ${driver.full_name}`,
    });

    // 3. Registrar en driver_transfers
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
    logger.error('Error en transferencia', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Error procesando transferencia' });
  }
}));

export const mercadoPagoTransfersRouter = router;
