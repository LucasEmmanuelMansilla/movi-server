import { Router } from 'express';
import { z } from 'zod';
import { createAdminClient } from '../lib/supabase';
import { StatusCodes } from 'http-status-codes';
import asyncHandler from 'express-async-handler';
import { logger } from '../utils/logger';
import { validateBody, validateParams, validateQuery } from '../utils/validation';
import { authMiddleware } from '../middleware/auth';
import { adminMiddleware } from '../middleware/admin';
import type { Role } from '../types';

const router = Router();

const CreateWithdrawalRequestBody = z.object({
  amount: z.number().positive().finite(),
});

// Estados permitidos para procesar un trámite:
// - closed: el dinero fue enviado correctamente
// - cancelled: el trámite se cancela con una razón
const ProcessWithdrawalBody = z.object({
  status: z.enum(['closed', 'cancelled']),
  cancellation_reason: z.string().optional(),
  admin_notes: z.string().optional(),
});

const ListWithdrawalsQuery = z.object({
  status: z.enum(['in_process', 'closed', 'cancelled']).optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

/**
 * POST /withdrawal-requests
 * Crear un trámite de retiro (usuarios)
 */
router.post('/', validateBody(CreateWithdrawalRequestBody), authMiddleware, asyncHandler(async (req, res) => {
  const user = req.user as { sub: string; role?: Role } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  const { amount } = req.body;
  const admin = createAdminClient();
  const adminAny = admin as any; // `withdrawal_requests` no está tipado en supabase.types

  // Verificar que el usuario sea driver y obtener datos bancarios
  const { data: profile } = await admin
    .from('profiles')
    .select(
      'role, bank_account_type, bank_cbu, bank_cvu, bank_alias, bank_name, bank_account_number, bank_account_holder_name'
    )
    .eq('id', user.sub)
    .maybeSingle();

  if (!profile || profile.role !== 'driver') {
    res.status(StatusCodes.FORBIDDEN).json({ error: 'Solo conductores pueden crear trámites de retiro' });
    return;
  }

  // Validar que el driver tenga datos bancarios completos según el tipo de cuenta
  const missingFields: string[] = [];
  const accountType = (profile as any).bank_account_type as
    | 'cbu'
    | 'cvu'
    | 'alias'
    | 'checking'
    | 'savings'
    | null;

  if (!accountType) {
    missingFields.push('Tipo de cuenta bancaria');
  } else {
    if (accountType === 'cbu' && !(profile as any).bank_cbu) {
      missingFields.push('CBU');
    }
    if (accountType === 'cvu' && !(profile as any).bank_cvu) {
      missingFields.push('CVU');
    }
    if (accountType === 'alias' && !(profile as any).bank_alias) {
      missingFields.push('Alias bancario');
    }
    if ((accountType === 'checking' || accountType === 'savings') && !(profile as any).bank_name) {
      missingFields.push('Nombre del banco');
    }
    if ((accountType === 'checking' || accountType === 'savings') && !(profile as any).bank_account_number) {
      missingFields.push('Número de cuenta bancaria');
    }
  }

  if (!(profile as any).bank_account_holder_name) {
    missingFields.push('Nombre del titular de la cuenta');
  }

  if (missingFields.length > 0) {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Debes completar tus datos bancarios para poder retirar dinero.',
      details: {
        missing_fields: missingFields,
      },
    });
    return;
  }

  // Verificar saldo disponible (similar a la lógica en driver-transfers)
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

  // Verificar si hay trámites pendientes que reduzcan el saldo disponible
  const { data: pendingRequests } = await adminAny
    .from('withdrawal_requests')
    .select('amount')
    .eq('user_id', user.sub)
    .eq('status', 'in_process');

  const pendingAmount = pendingRequests?.reduce(
    (sum: number, r: { amount: number }) => sum + (Number(r.amount) || 0),
    0
  ) || 0;
  const finalAvailableBalance = Math.round((availableBalance - pendingAmount) * 100) / 100;

  const MIN_WITHDRAW_AMOUNT_ARS = 1000;
  if (finalAvailableBalance <= MIN_WITHDRAW_AMOUNT_ARS) {
    res.status(StatusCodes.BAD_REQUEST).json({ 
      error: `Necesitás más de $${MIN_WITHDRAW_AMOUNT_ARS} disponibles para retirar`,
      availableBalance: finalAvailableBalance,
    });
    return;
  }

  if (amount > finalAvailableBalance) {
    res.status(StatusCodes.BAD_REQUEST).json({ 
      error: 'El monto supera tu saldo disponible',
      availableBalance: finalAvailableBalance,
    });
    return;
  }

  // Crear trámite de retiro en estado "in_process"
  const { data: withdrawalRequest, error: createError } = await adminAny
    .from('withdrawal_requests')
    .insert({
      user_id: user.sub,
      amount: amount,
      status: 'in_process',
      admin_id: null,
      money_sent: null,
      rejection_reason: null,
      admin_notes: null,
      processed_at: null,
    } as any)
    .select('*')
    .single();

  if (createError) {
    logger.error('Error creando trámite de retiro', createError as Error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Error creando trámite de retiro' });
    return;
  }

  logger.info('Trámite de retiro creado', { 
    withdrawalRequestId: withdrawalRequest.id, 
    userId: user.sub, 
    amount 
  });

  res.status(StatusCodes.CREATED).json({
    success: true,
    withdrawalRequest,
    message: `Trámite de retiro de $${amount} creado exitosamente. Un administrador lo procesará pronto.`,
  });
}));

/**
 * GET /withdrawal-requests
 * Listar trámites (usuarios ven los suyos, admins ven todos)
 */
router.get('/', validateQuery(ListWithdrawalsQuery), authMiddleware, asyncHandler(async (req, res) => {
  const user = req.user as { sub: string; role?: Role } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  const { status, limit = '50', offset = '0' } = req.query;
  const admin = createAdminClient();
  const adminAny = admin as any; // `withdrawal_requests` no está tipado en supabase.types

  // Verificar rol
  const { data: profile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', user.sub)
    .maybeSingle();

  const isAdmin = profile?.role === 'admin';

  let query = adminAny
    .from('withdrawal_requests')
    .select(`
      *,
      user:profiles!withdrawal_requests_user_id_fkey(id, full_name, email, phone)
    `)
    .order('created_at', { ascending: false })
    .range(parseInt(offset as string), parseInt(offset as string) + parseInt(limit as string) - 1);

  // Si no es admin, solo ver sus propios trámites
  if (!isAdmin) {
    query = query.eq('user_id', user.sub);
  }

  if (status) {
    query = query.eq('status', status as string);
  }

  const { data, error } = await query;

  if (error) {
    logger.error('Error listando trámites de retiro', error as Error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Error obteniendo trámites' });
    return;
  }

  res.json(data || []);
}));

/**
 * GET /withdrawal-requests/pending
 * Listar trámites pendientes (solo admins)
 */
router.get('/pending', authMiddleware, adminMiddleware, asyncHandler(async (req, res) => {
  const admin = createAdminClient();
  const adminAny = admin as any; // `withdrawal_requests` no está tipado en supabase.types

  const { data, error } = await adminAny
    .from('withdrawal_requests')
    .select(`
      *,
      user:profiles!withdrawal_requests_user_id_fkey(id, full_name, email, phone)
    `)
    .eq('status', 'in_process')
    .order('created_at', { ascending: true });

  if (error) {
    logger.error('Error obteniendo trámites pendientes', error as Error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Error obteniendo trámites pendientes' });
    return;
  }

  res.json(data || []);
}));

/**
 * GET /withdrawal-requests/:id
 * Obtener detalle de un trámite (solo admins), incluyendo datos bancarios del driver
 */
router.get(
  '/:id',
  validateParams(z.object({ id: z.string().uuid() })),
  authMiddleware,
  adminMiddleware,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const admin = createAdminClient();
    const adminAny = admin as any; // `withdrawal_requests` no está tipado en supabase.types

    const { data, error } = await adminAny
      .from('withdrawal_requests')
      .select(
        `
        *,
        user:profiles!withdrawal_requests_user_id_fkey(
          id,
          full_name,
          email,
          phone,
          bank_account_type,
          bank_cbu,
          bank_cvu,
          bank_alias,
          bank_name,
          bank_account_number,
          bank_account_holder_name
        )
      `
      )
      .eq('id', id)
      .maybeSingle();

    if (error) {
      logger.error('Error obteniendo detalle de trámite de retiro', error as Error);
      res
        .status(StatusCodes.INTERNAL_SERVER_ERROR)
        .json({ error: 'Error obteniendo trámite de retiro' });
      return;
    }

    if (!data) {
      res.status(StatusCodes.NOT_FOUND).json({ error: 'Trámite no encontrado' });
      return;
    }

    res.json(data);
  })
);

/**
 * PATCH /withdrawal-requests/:id/process
 * Procesar trámite (solo admins)
 */
router.patch('/:id/process', 
  validateParams(z.object({ id: z.string().uuid() })), 
  validateBody(ProcessWithdrawalBody), 
  authMiddleware, 
  adminMiddleware, 
  asyncHandler(async (req, res) => {
    const user = req.user as { sub: string } | undefined;
    const { id } = req.params;
    const { status, cancellation_reason, admin_notes } = req.body;
    const admin = createAdminClient();
    const adminAny = admin as any; // `withdrawal_requests` no está tipado en supabase.types

    // Verificar que el trámite existe y está en proceso
    const { data: withdrawalRequest, error: fetchError } = await adminAny
      .from('withdrawal_requests')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchError) {
      logger.error('Error obteniendo trámite', fetchError as Error);
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Error obteniendo trámite' });
      return;
    }

    if (!withdrawalRequest) {
      res.status(StatusCodes.NOT_FOUND).json({ error: 'Trámite no encontrado' });
      return;
    }

    if (withdrawalRequest.status !== 'in_process') {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'El trámite ya fue procesado' });
      return;
    }

    // Determinar el estado final
    if (status === 'cancelled' && !cancellation_reason) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Debe proporcionar una razón cuando se cancela el trámite',
      });
      return;
    }

    // Actualizar trámite
    const updateData: any = {
      status,
      admin_id: user!.sub,
      money_sent: status === 'closed',
      rejection_reason: cancellation_reason || null,
      admin_notes: admin_notes || null,
      processed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data: updated, error: updateError } = await adminAny
      .from('withdrawal_requests')
      .update(updateData)
      .eq('id', id)
      .select('*')
      .single();

    if (updateError) {
      logger.error('Error actualizando trámite', updateError as Error);
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Error procesando trámite' });
      return;
    }

    logger.info('Trámite procesado', { 
      withdrawalRequestId: id, 
      adminId: user!.sub, 
      status,
      moneySent: status === 'closed',
    });

    // Si el dinero fue enviado, crear un registro en driver_transfers para mantener consistencia
    if (status === 'closed') {
      try {
        await admin
          .from('driver_transfers')
          .insert({
            driver_id: withdrawalRequest.user_id,
            payment_id: null,
            amount: withdrawalRequest.amount,
            status: 'completed',
            transfer_method: 'manual',
            transferred_at: new Date().toISOString(),
            notes: `Retiro manual procesado. Trámite ID: ${id}. ${admin_notes || ''}`,
          } as any);
      } catch (transferError) {
        logger.warn('Error creando registro en driver_transfers', transferError as Error);
        // No fallar la operación si esto falla, solo loguear
      }
    }

    res.json(updated);
  })
);

export const withdrawalRequestsRouter = router;
