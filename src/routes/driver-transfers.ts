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

// Schema para crear transferencia
const CreateTransferBody = z.object({
  paymentId: z.string().uuid('ID de pago inválido'),
  transferMethod: z.enum(['manual', 'automatic', 'cash']).default('manual'),
  notes: z.string().optional(),
});

// Schema para actualizar transferencia
const UpdateTransferBody = z.object({
  status: z.enum(['pending', 'completed', 'failed', 'cancelled']),
  notes: z.string().optional(),
});

// Schema para query de listado
const ListTransfersQuery = z.object({
  driverId: z.string().uuid().optional(),
  status: z.enum(['pending', 'completed', 'failed', 'cancelled']).optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

/**
 * GET /driver-transfers
 * Lista transferencias (solo admin o el driver mismo)
 */
router.get('/', validateQuery(ListTransfersQuery), authMiddleware, asyncHandler(async (req, res) => {
  const user = req.user as { sub: string; role?: Role } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  const { driverId, status, limit = '50', offset = '0' } = req.query;
  const admin = createAdminClient();

  // Verificar si es admin o el driver mismo
  const { data: profile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', user.sub)
    .maybeSingle();

  // Por ahora, permitir a cualquier usuario autenticado ver sus propias transferencias
  // Puedes agregar rol 'admin' más adelante
  const isDriver = profile?.role === 'driver' && (!driverId || driverId === user.sub);

  if (!isDriver && driverId && driverId !== user.sub) {
    res.status(StatusCodes.FORBIDDEN).json({ error: 'No tienes permiso para ver estas transferencias' });
    return;
  }

  // Construir query
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
    // Si es driver y no admin, solo sus transferencias
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

/**
 * GET /driver-transfers/pending
 * Lista transferencias pendientes (para dashboard admin)
 */
router.get('/pending', authMiddleware, asyncHandler(async (req, res) => {
  const user = req.user as { sub: string; role?: Role } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  const admin = createAdminClient();

  // Obtener pagos aprobados que aún no tienen transferencia creada
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

  // Filtrar pagos que no tienen transferencia
  const paymentsWithoutTransfer = [];
  for (const payment of approvedPayments || []) {
    const { data: transfer } = await admin
      .from('driver_transfers')
      .select('id')
      .eq('payment_id', payment.id)
      .maybeSingle();

    if (!transfer) {
      // Obtener driver_id del envío
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

  // Obtener transferencias pendientes
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

/**
 * POST /driver-transfers
 * Crear transferencia manual (solo admin o automático)
 */
router.post('/', validateBody(CreateTransferBody), authMiddleware, asyncHandler(async (req, res) => {
  const user = req.user as { sub: string; role?: Role } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  const { paymentId, transferMethod, notes } = req.body;
  const admin = createAdminClient();

  // Verificar que el pago existe y está aprobado
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

  // Obtener driver_id del envío
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

  // Verificar que no existe transferencia para este pago
  const { data: existing } = await admin
    .from('driver_transfers')
    .select('id')
    .eq('payment_id', paymentId)
    .maybeSingle();

  if (existing) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Ya existe una transferencia para este pago' });
    return;
  }

  // Crear transferencia
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

/**
 * PATCH /driver-transfers/:id
 * Actualizar estado de transferencia
 */
router.patch('/:id', validateParams(z.object({ id: z.string().uuid() })), validateBody(UpdateTransferBody), authMiddleware, asyncHandler(async (req, res) => {
  const user = req.user as { sub: string; role?: Role } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  const { id } = req.params;
  const { status, notes } = req.body;
  const admin = createAdminClient();

  // Verificar que la transferencia existe
  const { data: transfer } = await admin
    .from('driver_transfers')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (!transfer) {
    res.status(StatusCodes.NOT_FOUND).json({ error: 'Transferencia no encontrada' });
    return;
  }

  // Actualizar
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

  // Enviar notificación al driver si se completó
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

/**
 * GET /driver-transfers/stats
 * Estadísticas de transferencias
 */
router.get('/stats', authMiddleware, asyncHandler(async (req, res) => {
  const user = req.user as { sub: string; role?: Role } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  const admin = createAdminClient();

  // Obtener rol del usuario para filtrar si es driver
  const { data: profile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', user.sub)
    .maybeSingle();

  // Obtener estadísticas filtradas por driver_id si el usuario es driver
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

  // Si es un driver, calcular el saldo real disponible (Pagos - Transferencias)
  let availableBalance = 0;
  if (profile?.role === 'driver') {
    try {
      // 1. Calcular total ganado (Pagos aprobados vinculados al driver de envíos ENTREGADOS)
      const { data: payments } = await admin
        .from('payments')
        .select(`
          driver_amount,
          shipment:shipments!payments_shipment_id_fkey(current_status)
        `)
        .eq('driver_id', user.sub)
        .eq('status', 'approved');

      // Solo contar pagos de envíos que ya fueron entregados
      const totalEarned = payments
        ?.filter(p => (p.shipment as any)?.current_status === 'delivered')
        .reduce((sum, p) => sum + (p.driver_amount || 0), 0) || 0;

      // 2. Calcular total retirado (Transferencias completadas)
      const totalWithdrawn = transfers?.filter((t: any) => t.status === 'completed')
        .reduce((sum: number, t: any) => sum + parseFloat(t.amount.toString()), 0) || 0;

      // El saldo "pendiente" para el driver es lo que ha ganado menos lo que ya retiró exitosamente
      availableBalance = Math.round((totalEarned - totalWithdrawn) * 100) / 100;
    } catch (err) {
      logger.error('Error calculando balance disponible en stats', err as Error);
    }
  }

  const total = transfers?.length || 0;
  const pending = transfers?.filter((t: any) => t.status === 'pending').length || 0;
  const completed = transfers?.filter((t: any) => t.status === 'completed').length || 0;
  const failed = transfers?.filter((t: any) => t.status === 'failed').length || 0;

  const totalAmount = transfers?.reduce((sum: number, t: any) => sum + parseFloat(t.amount.toString()), 0) || 0;
  
  // Para el driver, pendingAmount es el saldo que puede retirar
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

/**
 * POST /driver-transfers/withdraw
 * Inicia el retiro de fondos acumulados para el conductor autenticado
 */
router.post('/withdraw', authMiddleware, asyncHandler(async (req, res) => {
  const user = req.user as { sub: string; role?: Role } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  const admin = createAdminClient();

  // 1. Verificar perfil y conexión con Mercado Pago
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

  // 2. Calcular saldo disponible (Pagos aprobados de envíos entregados - Transferencias completadas)
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
    .select('amount')
    .eq('driver_id', user.sub)
    .eq('status', 'completed');

  const totalEarned = payments
    ?.filter(p => (p.shipment as any)?.current_status === 'delivered')
    .reduce((sum, p) => sum + (p.driver_amount || 0), 0) || 0;
  const totalWithdrawn = transfers?.reduce((sum, t) => sum + (t.amount || 0), 0) || 0;
  const availableBalance = Math.round((totalEarned - totalWithdrawn) * 100) / 100;

  if (availableBalance <= 0) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'No tienes saldo disponible para retirar' });
    return;
  }

  // 3. Ejecutar transferencia vía Mercado Pago
  const { MercadoPagoService } = await import('../services/mercadopago.service');
  const mpService = MercadoPagoService.getInstance();

  try {
    const idempotencyKey = `withdraw-${user.sub}-${new Date().getTime()}`;
    const transferResult = await mpService.transferToUser({
      amount: availableBalance,
      collectorId: profile.mp_user_id,
      description: `Retiro de fondos Movi - ${profile.full_name}`,
      externalReference: `withdraw-${user.sub}`,
    });

    // 4. Registrar la transferencia en nuestra BD
    const { data: transferRecord, error: dbError } = await admin
      .from('driver_transfers')
      .insert({
        driver_id: user.sub,
        payment_id: null, // No vinculado a un único pago, es un retiro global
        amount: availableBalance,
        status: 'completed',
        transfer_method: 'mercadopago',
        mp_transfer_id: transferResult.id.toString(),
        transferred_at: new Date().toISOString(),
        notes: `Retiro manual exitoso. MP ID: ${transferResult.id}`,
      } as any) // Cast a any porque payment_id es requerido en el tipo pero permitimos null en la app para retiros globales
      .select('*')
      .single();

    if (dbError) {
      logger.error('Error registrando retiro en BD', dbError as Error);
      // Notificamos éxito igual porque la transferencia en MP ocurrió
    }

    logger.info('Retiro exitoso procesado', { driverId: user.sub, amount: availableBalance });

    res.json({
      success: true,
      amount: availableBalance,
      transferId: transferResult.id,
      message: `Retiro de $${availableBalance} procesado exitosamente`
    });

  } catch (error: any) {
    logger.error('Error en proceso de retiro manual', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Error al procesar el retiro en Mercado Pago',
      message: error.message
    });
  }
}));

export const driverTransfersRouter = router;

