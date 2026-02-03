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
import { MercadoPagoService } from '../services/mercadopago.service';

const router = Router();
const mpService = MercadoPagoService.getInstance();

const CreateWithdrawalRequestBody = z.object({
  amount: z.number().positive().finite(),
});

// Estados permitidos para procesar un trámite:
// - approved: el dinero fue enviado correctamente (transferencia MP)
// - rejected: el trámite se rechaza con una razón
// - needs_details: admin solicita más datos al driver
const ProcessWithdrawalBody = z.object({
  status: z.enum(['approved', 'rejected', 'needs_details']),
  cancellation_reason: z.string().optional(),
  admin_notes: z.string().optional(),
});

const ListWithdrawalsQuery = z.object({
  status: z.enum(['pending', 'needs_details', 'approved', 'rejected']).optional(),
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

  // Verificar si hay trámites pendientes o que necesitan detalles (dinero comprometido)
  const { data: pendingRequests } = await adminAny
    .from('withdrawal_requests')
    .select('amount')
    .eq('user_id', user.sub)
    .in('status', ['pending', 'needs_details', 'in_process']);

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

  // Crear trámite de retiro en estado "pending" (dinero comprometido)
  const { data: withdrawalRequest, error: createError } = await adminAny
    .from('withdrawal_requests')
    .insert({
      user_id: user.sub,
      amount: amount,
      status: 'pending',
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
    amount,
    withdrawalRequestId: withdrawalRequest.id,
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
    .in('status', ['pending', 'needs_details'])
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
 * PATCH /withdrawal-requests/:id/request-details
 * Solicitar más detalles al driver (solo admins)
 */
const RequestDetailsBody = z.object({
  admin_notes: z.string().min(1, 'Debe indicar qué datos o aclaraciones necesita'),
});

router.patch(
  '/:id/request-details',
  validateParams(z.object({ id: z.string().uuid() })),
  validateBody(RequestDetailsBody),
  authMiddleware,
  adminMiddleware,
  asyncHandler(async (req, res) => {
    const user = req.user as { sub: string } | undefined;
    const { id } = req.params;
    const { admin_notes } = req.body;
    const admin = createAdminClient();
    const adminAny = admin as any;

    const { data: withdrawalRequest, error: fetchError } = await adminAny
      .from('withdrawal_requests')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (fetchError || !withdrawalRequest) {
      res.status(StatusCodes.NOT_FOUND).json({ error: 'Trámite no encontrado' });
      return;
    }

    if (withdrawalRequest.status !== 'pending') {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Solo se puede solicitar detalles en trámites pendientes',
      });
      return;
    }

    const { data: updated, error: updateError } = await adminAny
      .from('withdrawal_requests')
      .update({
        status: 'needs_details',
        admin_id: user!.sub,
        admin_notes,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single();

    if (updateError) {
      logger.error('Error actualizando trámite', updateError as Error);
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Error al solicitar detalles' });
      return;
    }

    logger.info('Detalles solicitados para trámite', { withdrawalRequestId: id, adminId: user!.sub });
    res.json(updated);
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

    const processableStatuses = ['pending', 'needs_details'];
    if (!processableStatuses.includes(withdrawalRequest.status)) {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'El trámite ya fue procesado' });
      return;
    }

    // Determinar el estado final
    if (status === 'rejected' && !cancellation_reason) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Debe proporcionar una razón cuando se rechaza el trámite',
      });
      return;
    }
    if (status === 'needs_details' && !admin_notes) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Debe indicar qué datos o aclaraciones necesita del driver',
      });
      return;
    }

    let mpTransferId: string | null = null;

    // Si aprobamos, ejecutar transferencia automática vía Mercado Pago ANTES de actualizar
    if (status === 'approved') {
      const { data: driverProfile } = await adminAny
        .from('profiles')
        .select('bank_cbu, bank_cvu, bank_alias, bank_account_holder_name, full_name')
        .eq('id', withdrawalRequest.user_id)
        .maybeSingle();

      if (!driverProfile?.bank_account_holder_name) {
        res.status(StatusCodes.BAD_REQUEST).json({
          error: 'El conductor no tiene datos bancarios completos. Solicita más detalles antes de aprobar.',
        });
        return;
      }

      const hasCbu = !!driverProfile.bank_cbu?.trim();
      const hasCvu = !!driverProfile.bank_cvu?.trim();
      const hasAlias = !!driverProfile.bank_alias?.trim();
      if (!hasCbu && !hasCvu && !hasAlias) {
        res.status(StatusCodes.BAD_REQUEST).json({
          error: 'El conductor no tiene CBU, CVU ni Alias registrado. Solicita más detalles.',
        });
        return;
      }

      try {
        const transferResult = await mpService.createMoneyTransfer({
          amount: withdrawalRequest.amount,
          currencyId: 'ARS',
          description: `Retiro Movi - Trámite ${id}`,
          recipient: {
            cbu: driverProfile.bank_cbu?.trim(),
            cvu: driverProfile.bank_cvu?.trim(),
            alias: driverProfile.bank_alias?.trim(),
            accountHolderName: driverProfile.bank_account_holder_name,
          },
        });
        mpTransferId = transferResult.id;
        logger.info('Transferencia MP ejecutada', { mpTransferId, withdrawalId: id });
      } catch (mpError: any) {
        logger.error('Error en transferencia Mercado Pago', mpError as Error, { withdrawalId: id });
        res.status(StatusCodes.BAD_GATEWAY).json({
          error: mpError?.message || 'Error al ejecutar la transferencia. Verifica saldo y datos bancarios.',
        });
        return;
      }
    }

    // Actualizar trámite
    const updateData: any = {
      status,
      admin_id: user!.sub,
      money_sent: status === 'approved',
      rejection_reason: cancellation_reason || null,
      admin_notes: admin_notes || null,
      processed_at: ['approved', 'rejected'].includes(status) ? new Date().toISOString() : null,
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
      moneySent: status === 'approved',
    });

    if (status === 'approved') {
      try {
        await adminAny
          .from('driver_transfers')
          .insert({
            driver_id: withdrawalRequest.user_id,
            payment_id: null,
            amount: withdrawalRequest.amount,
            status: 'completed',
            transfer_method: 'mercadopago',
            mp_transfer_id: mpTransferId,
            transferred_at: new Date().toISOString(),
            notes: `Retiro aprobado - Trámite ID: ${id}. ${admin_notes || ''}`,
          } as any);
      } catch (transferError) {
        logger.warn('Error creando registro en driver_transfers', transferError as Error);
      }
    }

    res.json(updated);
  })
);

export const withdrawalRequestsRouter = router;
