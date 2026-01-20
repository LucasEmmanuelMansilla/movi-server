import { Router } from 'express';
import { z } from 'zod';
import { createAdminClient } from '../lib/supabase';
import { StatusCodes } from 'http-status-codes';
import asyncHandler from 'express-async-handler';
import { logger } from '../utils/logger';
import { validateBody, validateParams, validateQuery } from '../utils/validation';
import { authMiddleware } from '../middleware/auth';
import type { Role } from '../types';
import { sendPush } from './push';

const router = Router();

const MIN_WITHDRAW_AMOUNT_ARS = 1000;

const CreateTransferBody = z.object({
  paymentId: z.string().uuid('ID de pago inválido'),
  transferMethod: z.enum(['manual', 'automatic', 'cash']).default('manual'),
  notes: z.string().optional(),
});

const UpdateTransferBody = z.object({
  status: z.enum(['pending', 'completed', 'failed', 'cancelled']),
  notes: z.string().optional(),
});

const ListTransfersQuery = z.object({
  driverId: z.string().uuid().optional(),
  status: z.enum(['pending', 'completed', 'failed', 'cancelled']).optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

const WithdrawBody = z.object({
  amount: z.preprocess((v) => {
    if (typeof v === 'string') {
      const normalized = v.replace(',', '.').trim();
      const n = Number(normalized);
      return Number.isFinite(n) ? n : v;
    }
    return v;
  }, z.number().finite().positive())
  .refine((n) => n > MIN_WITHDRAW_AMOUNT_ARS, {
    message: `El monto mínimo de retiro debe ser mayor a $${MIN_WITHDRAW_AMOUNT_ARS}`,
  }),
});

router.get('/', validateQuery(ListTransfersQuery), authMiddleware, asyncHandler(async (req, res) => {
  const user = req.user as { sub: string; role?: Role } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  const { driverId, status, limit = '50', offset = '0' } = req.query;
  const admin = createAdminClient();

  const { data: profile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', user.sub)
    .maybeSingle();

  const isDriver = profile?.role === 'driver' && (!driverId || driverId === user.sub);

  if (!isDriver && driverId && driverId !== user.sub) {
    res.status(StatusCodes.FORBIDDEN).json({ error: 'No tienes permiso para ver estas transferencias' });
    return;
  }

  let query = admin
    .from('driver_transfers')
    .select(`
      *,
      driver:profiles!driver_transfers_driver_id_fkey(id, full_name, email, phone),
      payment:payments!driver_transfers_payment_id_fkey(
        id,
        shipment_id,
        amount,
        driver_amount,
        commission_amount,
        status,
        created_at
      )
    `)
    .order('created_at', { ascending: false })
    .range(parseInt(offset as string), parseInt(offset as string) + parseInt(limit as string) - 1);

  if (driverId) {
    query = query.eq('driver_id', driverId as string);
  } else if (isDriver) {
    query = query.eq('driver_id', user.sub);
  }

  if (status) {
    query = query.eq('status', status as string);
  }

  const { data, error } = await query;

  if (error) {
    logger.error('Error listando transferencias', error as Error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Error obteniendo transferencias' });
    return;
  }

  res.json(data || []);
}));

router.get('/pending', authMiddleware, asyncHandler(async (req, res) => {
  const user = req.user as { sub: string; role?: Role } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  const admin = createAdminClient();

  const { data: approvedPayments, error: paymentsError } = await admin
    .from('payments')
    .select(`
      *,
      shipment:shipments!payments_shipment_id_fkey(
        id,
        title,
        created_by
      )
    `)
    .eq('status', 'approved')
    .order('created_at', { ascending: true });

  if (paymentsError) {
    logger.error('Error obteniendo pagos aprobados', paymentsError as Error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Error obteniendo pagos' });
    return;
  }

  const paymentsWithoutTransfer = [];
  for (const payment of approvedPayments || []) {
    const { data: transfer } = await admin
      .from('driver_transfers')
      .select('id')
      .eq('payment_id', payment.id)
      .maybeSingle();

    if (!transfer) {
      const { data: assignment } = await admin
        .from('driver_assignments')
        .select('driver_id')
        .eq('shipment_id', payment.shipment_id)
        .maybeSingle();

      if (assignment) {
        const { data: driver } = await admin
          .from('profiles')
          .select('id, full_name, email, phone')
          .eq('id', assignment.driver_id)
          .maybeSingle();

        paymentsWithoutTransfer.push({
          ...payment,
          driver: driver || null,
          driver_id: assignment.driver_id,
        });
      }
    }
  }

  const { data: pendingTransfers, error: transfersError } = await admin
    .from('driver_transfers')
    .select(`
      *,
      driver:profiles!driver_transfers_driver_id_fkey(id, full_name, email, phone),
      payment:payments!driver_transfers_payment_id_fkey(
        id,
        shipment_id,
        amount,
        driver_amount,
        commission_amount,
        status,
        created_at
      )
    `)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (transfersError) {
    logger.error('Error obteniendo transferencias pendientes', transfersError as Error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Error obteniendo transferencias' });
    return;
  }

  res.json({
    pendingPayments: paymentsWithoutTransfer,
    pendingTransfers: pendingTransfers || [],
  });
}));

router.post('/', validateBody(CreateTransferBody), authMiddleware, asyncHandler(async (req, res) => {
  const user = req.user as { sub: string; role?: Role } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  const { paymentId, transferMethod, notes } = req.body;
  const admin = createAdminClient();

  const { data: payment, error: paymentError } = await admin
    .from('payments')
    .select('id, status, driver_amount, shipment_id')
    .eq('id', paymentId)
    .single();

  if (paymentError || !payment) {
    res.status(StatusCodes.NOT_FOUND).json({ error: 'Pago no encontrado' });
    return;
  }

  if (payment.status !== 'approved') {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'El pago debe estar aprobado' });
    return;
  }

  const { data: assignment } = await admin
    .from('driver_assignments')
    .select('driver_id')
    .eq('shipment_id', payment.shipment_id)
    .maybeSingle();

  if (!assignment) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'El envío no tiene driver asignado' });
    return;
  }

  const driverId = assignment.driver_id;

  const { data: existing } = await admin
    .from('driver_transfers')
    .select('id')
    .eq('payment_id', paymentId)
    .maybeSingle();

  if (existing) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Ya existe una transferencia para este pago' });
    return;
  }

  const { data: transfer, error: transferError } = await admin
    .from('driver_transfers')
    .insert({
      driver_id: driverId,
      payment_id: paymentId,
      amount: payment.driver_amount,
      status: 'pending',
      transfer_method: transferMethod,
      notes: notes || null,
    })
    .select('*')
    .single();

  if (transferError) {
    logger.error('Error creando transferencia', transferError as Error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Error creando transferencia' });
    return;
  }

  logger.info('Transferencia creada', { transferId: transfer.id, paymentId, driverId });

  res.status(StatusCodes.CREATED).json(transfer);
}));

router.patch('/:id', validateParams(z.object({ id: z.string().uuid() })), validateBody(UpdateTransferBody), authMiddleware, asyncHandler(async (req, res) => {
  const user = req.user as { sub: string; role?: Role } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  const { id } = req.params;
  const { status, notes } = req.body;
  const admin = createAdminClient();

  const { data: transfer } = await admin
    .from('driver_transfers')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (!transfer) {
    res.status(StatusCodes.NOT_FOUND).json({ error: 'Transferencia no encontrada' });
    return;
  }

  const updateData: any = { status };
  if (notes !== undefined) {
    updateData.notes = notes;
  }
  if (status === 'completed') {
    updateData.transferred_at = new Date().toISOString();
  }

  const { data: updated, error: updateError } = await admin
    .from('driver_transfers')
    .update(updateData)
    .eq('id', id)
    .select('*')
    .single();

  if (updateError) {
    logger.error('Error actualizando transferencia', updateError as Error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Error actualizando transferencia' });
    return;
  }

  logger.info('Transferencia actualizada', { transferId: id, status });

  if (status === 'completed') {
    try {
      const { data: tokens } = await admin
        .from('push_tokens')
        .select('token')
        .eq('user_id', transfer.driver_id);

      const pushTokens = (tokens || []).map(t => t.token);
      if (pushTokens.length > 0) {
        await sendPush(
          pushTokens,
          'Pago transferido',
          `Se transfirió $${transfer.amount.toFixed(2)} a tu cuenta`
        );
        logger.info('Notificación enviada al driver', { driverId: transfer.driver_id });
      }
    } catch (error) {
      logger.error('Error enviando notificación', error as Error);
    }
  }

  res.json(updated);
}));

router.get('/stats', authMiddleware, asyncHandler(async (req, res) => {
  const user = req.user as { sub: string; role?: Role } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  const admin = createAdminClient();

  const { data: profile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', user.sub)
    .maybeSingle();

  let query = admin.from('driver_transfers').select('status, amount');

  if (profile?.role === 'driver') {
    query = query.eq('driver_id', user.sub);
  }

  const { data: transfers, error } = await query;

  if (error) {
    logger.error('Error obteniendo estadísticas', error as Error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Error obteniendo estadísticas' });
    return;
  }

  let availableBalance = 0;
  if (profile?.role === 'driver') {
    try {
      const { data: payments } = await admin
        .from('payments')
        .select(`
          driver_amount,
          shipment:shipments!payments_shipment_id_fkey(current_status)
        `)
        .eq('driver_id', user.sub)
        .eq('status', 'approved');

      const totalEarned = payments
        ?.filter(p => (p.shipment as any)?.current_status === 'delivered')
        .reduce((sum, p) => sum + (p.driver_amount || 0), 0) || 0;

      // Reservar también transferencias pendientes para evitar doble retiro/solapamiento.
      const reservedOrPaid = transfers
        ?.filter((t: any) => t.status === 'completed' || t.status === 'pending')
        .reduce((sum: number, t: any) => sum + (Number(t?.amount) || 0), 0) || 0;

      availableBalance = Math.round((totalEarned - reservedOrPaid) * 100) / 100;
    } catch (err) {
      logger.error('Error calculando balance disponible en stats', err as Error);
    }
  }

  const total = transfers?.length || 0;
  const pending = transfers?.filter((t: any) => t.status === 'pending').length || 0;
  const completed = transfers?.filter((t: any) => t.status === 'completed').length || 0;
  const failed = transfers?.filter((t: any) => t.status === 'failed').length || 0;

  const totalAmount = transfers?.reduce((sum: number, t: any) => sum + parseFloat(t.amount.toString()), 0) || 0;
  
  const pendingAmount = profile?.role === 'driver' 
    ? availableBalance 
    : transfers?.filter((t: any) => t.status === 'pending').reduce((sum: number, t: any) => sum + parseFloat(t.amount.toString()), 0) || 0;
    
  const completedAmount = transfers?.filter((t: any) => t.status === 'completed').reduce((sum: number, t: any) => sum + parseFloat(t.amount.toString()), 0) || 0;

  res.json({
    total,
    pending,
    completed,
    failed,
    totalAmount: Math.round(totalAmount * 100) / 100,
    pendingAmount: Math.round(pendingAmount * 100) / 100,
    completedAmount: Math.round(completedAmount * 100) / 100,
  });
}));

router.post('/withdraw', validateBody(WithdrawBody), authMiddleware, asyncHandler(async (req, res) => {
  const user = req.user as { sub: string; role?: Role } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  const requestedAmountRaw = (req.body as any)?.amount;
  const requestedAmount = Math.round(Number(requestedAmountRaw) * 100) / 100;

  const admin = createAdminClient();

  const { data: profile } = await admin
    .from('profiles')
    .select('id, role, mp_user_id, mp_status, full_name')
    .eq('id', user.sub)
    .single();

  if (!profile || profile.role !== 'driver') {
    res.status(StatusCodes.FORBIDDEN).json({ error: 'Solo conductores pueden retirar fondos' });
    return;
  }

  if (!profile.mp_user_id || profile.mp_status !== 'connected') {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Debes conectar tu cuenta de Mercado Pago para retirar fondos' });
    return;
  }

  const { data: payments } = await admin
    .from('payments')
    .select(`
      driver_amount,
      shipment:shipments!payments_shipment_id_fkey(current_status)
    `)
    .eq('driver_id', user.sub)
    .eq('status', 'approved');

  const { data: transfers } = await admin
    .from('driver_transfers')
    .select('status, amount')
    .eq('driver_id', user.sub)
    .in('status', ['pending', 'completed'] as any);

  const totalEarned = payments
    ?.filter(p => (p.shipment as any)?.current_status === 'delivered')
    .reduce((sum, p) => sum + (p.driver_amount || 0), 0) || 0;
  const reservedOrPaid = transfers?.reduce((sum, t: any) => sum + (Number(t?.amount) || 0), 0) || 0;
  const availableBalance = Math.round((totalEarned - reservedOrPaid) * 100) / 100;

  if (availableBalance <= MIN_WITHDRAW_AMOUNT_ARS) {
    res.status(StatusCodes.BAD_REQUEST).json({ 
      error: `Necesitás más de $${MIN_WITHDRAW_AMOUNT_ARS} disponibles para retirar`,
      availableBalance,
    });
    return;
  }

  if (requestedAmount > availableBalance) {
    res.status(StatusCodes.BAD_REQUEST).json({ 
      error: 'El monto supera tu saldo disponible',
      availableBalance,
    });
    return;
  }

  const { MercadoPagoService } = await import('../services/mercadopago.service');
  const mpService = MercadoPagoService.getInstance();

  try {
    const idempotencyKey = `withdraw-${user.sub}-${requestedAmount}-${new Date().getTime()}`;
    const transferResult = await mpService.transferToUser({
      amount: requestedAmount,
      collectorId: profile.mp_user_id,
      description: `Retiro de fondos Movi - ${profile.full_name}`,
      externalReference: `withdraw-${user.sub}`,
      idempotencyKey,
    });

    const { data: transferRecord, error: dbError } = await admin
      .from('driver_transfers')
      .insert({
        driver_id: user.sub,
        payment_id: null,
        amount: requestedAmount,
        status: 'completed',
        transfer_method: 'mercadopago',
        mp_transfer_id: transferResult?.id?.toString?.() || null,
        transferred_at: new Date().toISOString(),
        notes: `Retiro exitoso a Mercado Pago. MP ID: ${transferResult?.id}`,
      } as any)
      .select('*')
      .single();

    if (dbError) {
      logger.error('Error registrando retiro en BD', dbError as Error);
    }

    logger.info('Retiro exitoso procesado', { driverId: user.sub, amount: requestedAmount });

    res.json({
      success: true,
      amount: requestedAmount,
      transferId: transferResult?.id,
      message: `Retiro de $${requestedAmount} procesado exitosamente`
    });

  } catch (error: any) {
    // Fallback: si MP no está habilitado/configurado para payouts por API, crear solicitud pendiente.
    const msg = String(error?.message || '');
    const isMarketplaceRequired =
      msg.includes('marketplace is required') || msg.includes('400011') || msg.includes('"marketplace"');
    const isPlatformConfigMissing =
      msg.includes('Falta configuración de plataforma/marketplace') || msg.includes('MP_PLATFORM_ID') || msg.includes('MP_MARKETPLACE_ID');

    if (isMarketplaceRequired || isPlatformConfigMissing) {
      logger.warn('MP no disponible para retiro automático; creando retiro pendiente', {
        driverId: user.sub,
        requestedAmount,
        reason: msg,
      });

      const { error: pendingError } = await admin
        .from('driver_transfers')
        .insert({
          driver_id: user.sub,
          payment_id: null,
          amount: requestedAmount,
          status: 'pending',
          transfer_method: 'manual',
          transferred_at: null,
          notes: `Solicitud de retiro creada. Pendiente de procesamiento. Motivo: ${msg}`.slice(0, 500),
        } as any);

      if (pendingError) {
        logger.error('Error registrando retiro pendiente en BD', pendingError as Error);
        res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
          error: 'Error al registrar la solicitud de retiro',
          message: 'No se pudo crear el retiro pendiente. Intenta nuevamente.',
        });
        return;
      }

      res.status(StatusCodes.ACCEPTED).json({
        success: true,
        amount: requestedAmount,
        message: 'Solicitud de retiro creada y pendiente de procesamiento. Te avisaremos cuando se acredite.',
      });
      return;
    }

    logger.error('Error en proceso de retiro', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Error al procesar el retiro en Mercado Pago',
      message: msg
    });
  }
}));

export const driverTransfersRouter = router;

