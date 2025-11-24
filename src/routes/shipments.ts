import { Router } from 'express';
import { z } from 'zod';
import { createAdminClient } from '../lib/supabase';
import type { Role, ShipmentStatus } from '../types';
import { sendPush } from './push';
import { StatusCodes } from 'http-status-codes';
import asyncHandler from 'express-async-handler';

const router = Router();

const CreateShipmentBody = z.object({
  title: z.string().min(3),
  description: z.string().optional(),
  pickup_address: z.string().min(3),
  dropoff_address: z.string().min(3),
  price: z.number().nonnegative().optional(),
});

// ✅ Crear envío (solo business)
router.post('/', asyncHandler(async (req, res) => {
  const user = req.user as { sub: string; role?: Role } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Unauthorized' });
    return;
  }

  const parse = CreateShipmentBody.safeParse(req.body);
  if (!parse.success) {
    res.status(StatusCodes.BAD_REQUEST).json({ 
      error: 'Invalid body', 
      details: parse.error.flatten() 
    });
    return;
  }

  const body = parse.data;
  const admin = createAdminClient();

  // Verificar rol
  const { data: profile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', user.sub)
    .maybeSingle();

  if (!profile || profile.role !== 'business') {
    res.status(StatusCodes.FORBIDDEN).json({ 
      error: 'Only business can create shipments' 
    });
    return;
  }

  const { data, error } = await admin
    .from('shipments')
    .insert({
      title: body.title,
      description: body.description ?? null,
      pickup_address: body.pickup_address,
      dropoff_address: body.dropoff_address,
      price: body.price ?? null,
      created_by: user.sub,
      current_status: 'created',
    })
    .select('*')
    .single();

  if (error) {
    console.error('Error creating shipment:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'Failed to create shipment' 
    });
    return;
  }

  res.status(StatusCodes.CREATED).json(data);
}));


// ✅ Listar envíos
router.get('/', asyncHandler(async (req, res) => {
  const user = req.user as { sub: string; role?: Role } | undefined;
  console.log("🚀 ~ user:", user)
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Unauthorized' });
    return;
  }

  const scope = req.query.scope as 'available' | 'mine' | undefined;
  const admin = createAdminClient();

  const { data: profile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', user.sub)
    .maybeSingle();

  const role = profile?.role as Role | undefined;

  try {
    if (scope === 'available') {
      const { data, error } = await admin
        .from('shipments')
        .select('*')
        .eq('current_status', 'created')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      res.json(data);
      return;
    }

    if (scope === 'mine') {
      if (role === 'business') {
        const { data, error } = await admin
          .from('shipments')
          .select('*')
          .eq('created_by', user.sub)
          .order('created_at', { ascending: false });
        
        if (error) throw error;
        res.json(data);
        return;
      } else {
        const { data: assignments, error: aErr } = await admin
          .from('driver_assignments')
          .select('shipment_id')
          .eq('driver_id', user.sub);
        
        if (aErr) throw aErr;

        const ids = (assignments ?? []).map((a) => a.shipment_id);
        if (ids.length === 0) {
          res.json([]);
          return;
        }

        const { data, error } = await admin
          .from('shipments')
          .select('*')
          .in('id', ids)
          .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data);
        return;
      }
    }

    // default: listado general
    const { data, error } = await admin
      .from('shipments')
      .select('*')
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    res.json(data);
  } catch (error) {
    console.error('Error listing shipments:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'Failed to list shipments' 
    });
  }
}));

// ✅ Aceptar envío (solo driver)
router.post('/:id/accept', asyncHandler(async (req, res) => {
  const user = req.user as { sub: string; role?: Role } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Unauthorized' });
    return;
  }

  const shipmentId = req.params.id;
  const admin = createAdminClient();

  const { data: profile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', user.sub)
    .maybeSingle();
  
  if (!profile || profile.role !== 'driver') {
    res.status(StatusCodes.FORBIDDEN).json({ 
      error: 'Only drivers can accept shipments' 
    });
    return;
  }

  const { data: shipment } = await admin
    .from('shipments')
    .select('id, current_status, created_by')
    .eq('id', shipmentId)
    .maybeSingle();

  if (!shipment) {
    res.status(StatusCodes.NOT_FOUND).json({ error: 'Shipment not found' });
    return;
  }
  
  if (shipment.current_status !== 'created') {
    res.status(StatusCodes.BAD_REQUEST).json({ 
      error: 'Shipment not available' 
    });
    return;
  }

  const { data: exists } = await admin
    .from('driver_assignments')
    .select('id')
    .eq('shipment_id', shipmentId)
    .maybeSingle();
  
  if (exists) {
    res.status(StatusCodes.BAD_REQUEST).json({ 
      error: 'Shipment already assigned' 
    });
    return;
  }

  const { error: aErr } = await admin
    .from('driver_assignments')
    .insert({ shipment_id: shipmentId, driver_id: user.sub });
  
  if (aErr) {
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'Failed to assign driver' 
    });
    return;
  }

  const { error: upErr } = await admin
    .from('shipments')
    .update({ current_status: 'assigned' })
    .eq('id', shipmentId);
  
  if (upErr) {
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'Failed to update shipment status' 
    });
    return;
  }

  await admin.from('shipment_statuses').insert({ 
    shipment_id: shipmentId, 
    status: 'assigned', 
    note: 'Driver assigned', 
    created_by: user.sub 
  });

  // Notificar al dueño del envío
  const { data: tokens } = await admin
    .from('push_tokens')
    .select('token')
    .eq('user_id', shipment.created_by);
  
  const pushTokens = (tokens ?? []).map((t) => t.token);
  await sendPush(pushTokens, 'Envío asignado', 'Un chofer aceptó tu envío');

  res.json({ ok: true });
}));


// ✅ Cambiar estado
router.post('/:id/status', asyncHandler(async (req, res) => {
  const user = req.user as { sub: string } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Unauthorized' });
    return;
  }

  const shipmentId = req.params.id;
  const Body = z.object({ 
    status: z.enum(['picked_up', 'in_transit', 'delivered', 'cancelled']), 
    note: z.string().optional() 
  });
  
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(StatusCodes.BAD_REQUEST).json({ 
      error: 'Invalid body', 
      details: parsed.error.flatten() 
    });
    return;
  }

  const { status, note } = parsed.data;
  const admin = createAdminClient();

  // Obtener información del envío
  const { data: shipment, error: shipError } = await admin
    .from('shipments')
    .select('id, created_by, current_status')
    .eq('id', shipmentId)
    .maybeSingle();
  
  if (shipError) {
    console.error('Error fetching shipment:', shipError);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'Failed to fetch shipment' 
    });
    return;
  }

  if (!shipment) {
    res.status(StatusCodes.NOT_FOUND).json({ 
      error: 'Shipment not found' 
    });
    return;
  }

  // Verificar permisos
  const { data: assign, error: assignError } = await admin
    .from('driver_assignments')
    .select('driver_id')
    .eq('shipment_id', shipmentId)
    .maybeSingle();

  if (assignError) {
    console.error('Error fetching assignment:', assignError);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'Failed to verify permissions' 
    });
    return;
  }

  const isOwner = shipment.created_by === user.sub;
  const isDriver = assign?.driver_id === user.sub;
  
  if (!isOwner && !isDriver) {
    res.status(StatusCodes.FORBIDDEN).json({ 
      error: 'Not allowed to update status' 
    });
    return;
  }

  // Actualizar estado del envío
  const { error: updateError } = await admin
    .from('shipments')
    .update({ current_status: status })
    .eq('id', shipmentId);
  
  if (updateError) {
    console.error('Error updating shipment status:', updateError);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'Failed to update shipment status' 
    });
    return;
  }

  // Registrar el cambio de estado
  const { error: statusError } = await admin
    .from('shipment_statuses')
    .insert({ 
      shipment_id: shipmentId, 
      status, 
      note: note || null, 
      created_by: user.sub 
    });

  if (statusError) {
    console.error('Error saving status update:', statusError);
    // No fallamos aquí, solo registramos el error
  }

  // Notificar a los usuarios relevantes
  try {
    const notifyUsers = new Set<string>([shipment.created_by]);
    if (assign?.driver_id) {
      notifyUsers.add(assign.driver_id);
    }

    const { data: tokens } = await admin
      .from('push_tokens')
      .select('token')
      .in('user_id', Array.from(notifyUsers));
    
    const pushTokens = (tokens || []).map(t => t.token);
    if (pushTokens.length > 0) {
      await sendPush(
        pushTokens, 
        'Actualización de envío', 
        `Nuevo estado: ${status}`
      );
    }
  } catch (pushError) {
    console.error('Error sending push notifications:', pushError);
    // No fallamos por errores de notificaciones push
  }

  res.json({ ok: true });
}));

// ✅ Obtener historial de estados
router.get('/:id/statuses', asyncHandler(async (req, res) => {
  const shipmentId = req.params.id;
  const admin = createAdminClient();

  const { data, error } = await admin
    .from('shipment_statuses')
    .select(`
      id,
      status,
      note,
      created_at,
      profiles:created_by ( id, full_name )
    `)
    .eq('shipment_id', shipmentId)
    .order('created_at', { ascending: true });
  
  if (error) {
    console.error('Error fetching status history:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'Failed to fetch status history' 
    });
    return;
  }

  res.json(data || []);
}));

export const shipmentRouter = router;