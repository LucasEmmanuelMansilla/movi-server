import { Router } from 'express';
import { z } from 'zod';
import { createAdminClient } from '../lib/supabase';
import type { Role, ShipmentStatus } from '../types';
import { sendPush } from './push';
import { StatusCodes } from 'http-status-codes';
import asyncHandler from 'express-async-handler';
import { logger } from '../utils/logger';
import { titleSchema, descriptionSchema, addressSchema, priceSchema, validateBody, validateQuery, validateParams } from '../utils/validation';
import { parseAddressWithCoordinates, geocodeAddress, filterNearbyUsers } from '../utils/geolocation';

const router = Router();

const CreateShipmentBody = z.object({
  title: titleSchema,
  description: descriptionSchema,
  pickup_address: addressSchema,
  dropoff_address: addressSchema,
  price: priceSchema.optional(),
});

// ✅ Crear envío (solo business)
router.post('/', validateBody(CreateShipmentBody), asyncHandler(async (req, res) => {
  const user = req.user as { sub: string; role?: Role } | undefined;
  if (!user?.sub) {
    logger.warn('Intento de crear envío sin autenticación');
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  const body = req.body;
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

  // Parsear dirección para obtener coordenadas si están disponibles
  const parsedPickup = parseAddressWithCoordinates(body.pickup_address);
  let pickupLat: number | undefined = parsedPickup.lat;
  let pickupLng: number | undefined = parsedPickup.lng;

  // Si no hay coordenadas, intentar geocodificar la dirección
  if (!pickupLat || !pickupLng) {
    try {
      const coords = await geocodeAddress(parsedPickup.address);
      if (coords) {
        pickupLat = coords.lat;
        pickupLng = coords.lng;
      }
    } catch (geocodeError) {
      logger.warn('Error geocodificando dirección de pickup', { error: geocodeError });
      // Continuar sin coordenadas, las notificaciones se enviarán a todos los drivers disponibles
    }
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
    logger.error('Error al crear envío', error as Error, { userId: user.sub });
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'No se pudo crear el envío' 
    });
    return;
  }

  // Notificar a drivers cercanos al lugar de retiro
  try {
    if (pickupLat && pickupLng) {
      // Obtener todos los drivers disponibles
      const { data: drivers } = await admin
        .from('profiles')
        .select('id, latitude, longitude, role')
        .eq('role', 'driver')
        .not('latitude', 'is', null)
        .not('longitude', 'is', null);

      if (drivers && drivers.length > 0) {
        // Filtrar drivers cercanos (dentro de 10km por defecto)
        const nearbyDrivers = filterNearbyUsers(
          drivers as any[],
          pickupLat,
          pickupLng,
          10 // radio en km
        );

        if (nearbyDrivers.length > 0) {
          // Obtener tokens de push de los drivers cercanos
          const driverIds = nearbyDrivers.map(d => d.id);
          const { data: tokens } = await admin
            .from('push_tokens')
            .select('token')
            .in('user_id', driverIds);

          const pushTokens = (tokens ?? []).map((t) => t.token);
          
          if (pushTokens.length > 0) {
            await sendPush(
              pushTokens,
              'Nuevo envío disponible',
              `${body.title} - Recoger en: ${parsedPickup.address}`
            );
            logger.info('Notificaciones enviadas a drivers cercanos', { 
              shipmentId: data.id, 
              driversCount: nearbyDrivers.length 
            });
          }
        } else {
          // Si no hay drivers cercanos, notificar a todos los drivers disponibles
          logger.info('No hay drivers cercanos, notificando a todos los drivers', { shipmentId: data.id });
          await notifyAllAvailableDrivers(admin, body.title, parsedPickup.address, data.id);
        }
      } else {
        // Si no hay ubicaciones de drivers, notificar a todos
        await notifyAllAvailableDrivers(admin, body.title, parsedPickup.address, data.id);
      }
    } else {
      // Si no hay coordenadas, notificar a todos los drivers disponibles
      await notifyAllAvailableDrivers(admin, body.title, parsedPickup.address, data.id);
    }
  } catch (notifyError) {
    logger.error('Error enviando notificaciones a drivers', notifyError as Error, { shipmentId: data.id });
    // No fallamos si hay error en las notificaciones
  }

  logger.info('Envío creado exitosamente', { shipmentId: data.id, userId: user.sub });
  res.status(StatusCodes.CREATED).json(data);
}));

// Función auxiliar para notificar a todos los drivers disponibles
async function notifyAllAvailableDrivers(
  admin: ReturnType<typeof createAdminClient>,
  title: string,
  address: string,
  shipmentId: string
) {
  try {
    // Obtener todos los drivers
    const { data: drivers } = await admin
      .from('profiles')
      .select('id')
      .eq('role', 'driver');

    if (!drivers || drivers.length === 0) {
      return;
    }

    const driverIds = drivers.map(d => d.id);
    const { data: tokens } = await admin
      .from('push_tokens')
      .select('token')
      .in('user_id', driverIds);

    const pushTokens = (tokens ?? []).map((t) => t.token);
    
    if (pushTokens.length > 0) {
      await sendPush(
        pushTokens,
        'Nuevo envío disponible',
        `${title} - Recoger en: ${address}`
      );
      logger.info('Notificaciones enviadas a todos los drivers', { 
        shipmentId, 
        driversCount: drivers.length 
      });
    }
  } catch (error) {
    logger.error('Error notificando a todos los drivers', error as Error, { shipmentId });
  }
}


// ✅ Listar envíos
const ListShipmentsQuery = z.object({
  scope: z.enum(['available', 'mine']).optional(),
});

router.get('/', validateQuery(ListShipmentsQuery), asyncHandler(async (req, res) => {
  const user = req.user as { sub: string; role?: Role } | undefined;
  if (!user?.sub) {
    logger.warn('Intento de listar envíos sin autenticación');
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
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
    logger.error('Error al listar envíos', error as Error, { userId: user.sub, scope });
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'No se pudieron listar los envíos' 
    });
  }
}));

// ✅ Aceptar envío (solo driver)
const AcceptShipmentParams = z.object({
  id: z.string().uuid('ID de envío inválido'),
});

router.post('/:id/accept', validateParams(AcceptShipmentParams), asyncHandler(async (req, res) => {
  const user = req.user as { sub: string; role?: Role } | undefined;
  if (!user?.sub) {
    logger.warn('Intento de aceptar envío sin autenticación');
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
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
    logger.error('Error al asignar conductor', aErr as Error, { shipmentId, driverId: user.sub });
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'No se pudo asignar el conductor' 
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

  // Obtener información del envío y del driver para las notificaciones
  const { data: shipmentInfo } = await admin
    .from('shipments')
    .select('title, pickup_address')
    .eq('id', shipmentId)
    .single();

  const { data: driverProfile } = await admin
    .from('profiles')
    .select('full_name')
    .eq('id', user.sub)
    .single();

  // Notificar al dueño del envío (business)
  try {
    const { data: ownerTokens } = await admin
      .from('push_tokens')
      .select('token')
      .eq('user_id', shipment.created_by);
    
    const ownerPushTokens = (ownerTokens ?? []).map((t) => t.token);
    if (ownerPushTokens.length > 0) {
      const driverName = driverProfile?.full_name || 'Un chofer';
      await sendPush(
        ownerPushTokens, 
        'Envío aceptado', 
        `${driverName} aceptó tu envío: ${shipmentInfo?.title || 'Sin título'}`
      );
    }
  } catch (notifyError) {
    logger.error('Error notificando al dueño del envío', notifyError as Error, { shipmentId });
    // No fallamos si hay error en las notificaciones
  }

  // Notificar al driver que aceptó el envío
  try {
    const { data: driverTokens } = await admin
      .from('push_tokens')
      .select('token')
      .eq('user_id', user.sub);
    
    const driverPushTokens = (driverTokens ?? []).map((t) => t.token);
    if (driverPushTokens.length > 0) {
      await sendPush(
        driverPushTokens,
        'Envío aceptado',
        `Has aceptado el envío: ${shipmentInfo?.title || 'Sin título'}. Ve a recoger en: ${shipmentInfo?.pickup_address || 'la dirección indicada'}`
      );
    }
  } catch (notifyError) {
    logger.error('Error notificando al driver', notifyError as Error, { shipmentId });
    // No fallamos si hay error en las notificaciones
  }

  logger.info('Envío aceptado exitosamente', { shipmentId, driverId: user.sub });
  res.json({ ok: true });
}));


// ✅ Cambiar estado
const UpdateStatusParams = z.object({
  id: z.string().uuid('ID de envío inválido'),
});

const UpdateStatusBody = z.object({ 
  status: z.enum(['picked_up', 'in_transit', 'delivered', 'cancelled']), 
  note: z.string().max(500).optional() 
});

router.post('/:id/status', validateParams(UpdateStatusParams), validateBody(UpdateStatusBody), asyncHandler(async (req, res) => {
  const user = req.user as { sub: string } | undefined;
  if (!user?.sub) {
    logger.warn('Intento de actualizar estado sin autenticación');
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  const shipmentId = req.params.id;
  const { status, note } = req.body;
  const admin = createAdminClient();

  // Obtener información del envío
  const { data: shipment, error: shipError } = await admin
    .from('shipments')
    .select('id, created_by, current_status')
    .eq('id', shipmentId)
    .maybeSingle();
  
  if (shipError) {
    logger.error('Error al obtener envío', shipError as Error, { shipmentId });
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'No se pudo obtener el envío' 
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
    logger.error('Error al verificar asignación', assignError as Error, { shipmentId });
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'No se pudieron verificar los permisos' 
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
    logger.error('Error al actualizar estado', updateError as Error, { shipmentId, status });
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'No se pudo actualizar el estado' 
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
    logger.error('Error al guardar actualización de estado', statusError as Error, { shipmentId });
    // No fallamos aquí, solo registramos el error
  }

  // Obtener información del envío para las notificaciones
  const { data: shipmentInfo } = await admin
    .from('shipments')
    .select('title, pickup_address, dropoff_address')
    .eq('id', shipmentId)
    .single();

  // Notificar a los usuarios relevantes con mensajes específicos según el estado
  try {
    const notifyUsers = new Set<string>([shipment.created_by]);
    if (assign?.driver_id) {
      notifyUsers.add(assign.driver_id);
    }

    const { data: tokens } = await admin
      .from('push_tokens')
      .select('token, user_id')
      .in('user_id', Array.from(notifyUsers));
    
    if (tokens && tokens.length > 0) {
      // Crear mensajes personalizados según el estado
    let title = 'Actualización de envío';
    let body = '';

    switch (status) {
      case 'picked_up':
        title = 'Envío recogido';
        body = `El envío "${shipmentInfo?.title || 'Sin título'}" ha sido recogido. Está en camino a su destino.`;
        break;
      case 'in_transit':
        title = 'Envío en tránsito';
        body = `El envío "${shipmentInfo?.title || 'Sin título'}" está en camino hacia: ${shipmentInfo?.dropoff_address || 'el destino'}`;
        break;
      case 'delivered':
        title = 'Envío entregado';
        body = `El envío "${shipmentInfo?.title || 'Sin título'}" ha sido entregado exitosamente en: ${shipmentInfo?.dropoff_address || 'el destino'}`;
        break;
      case 'cancelled':
        title = 'Envío cancelado';
        body = `El envío "${shipmentInfo?.title || 'Sin título'}" ha sido cancelado.`;
        break;
      default:
        body = `Nuevo estado: ${status}`;
    }

    // Separar tokens por usuario para enviar notificaciones personalizadas
    const ownerTokens = tokens
      .filter(t => t.user_id === shipment.created_by)
      .map(t => t.token);
    
    const driverTokens = assign?.driver_id
      ? tokens
          .filter(t => t.user_id === assign.driver_id)
          .map(t => t.token)
      : [];

    // Notificar al dueño (business)
    if (ownerTokens.length > 0) {
      await sendPush(ownerTokens, title, body);
    }

    // Notificar al driver con mensajes específicos
    if (driverTokens.length > 0) {
      let driverTitle = title;
      let driverBody = '';

      switch (status) {
        case 'picked_up':
          driverTitle = '¡Bien hecho!';
          driverBody = `Has recogido el envío "${shipmentInfo?.title || 'Sin título'}". Dirígete al destino: ${shipmentInfo?.dropoff_address || 'la dirección indicada'}`;
          break;
        case 'in_transit':
          driverTitle = 'En camino';
          driverBody = `Continúa hacia: ${shipmentInfo?.dropoff_address || 'el destino'} con el envío "${shipmentInfo?.title || 'Sin título'}"`;
          break;
        case 'delivered':
          driverTitle = '¡Entrega completada!';
          driverBody = `Has entregado exitosamente el envío "${shipmentInfo?.title || 'Sin título'}" en: ${shipmentInfo?.dropoff_address || 'el destino'}`;
          break;
        case 'cancelled':
          driverTitle = 'Envío cancelado';
          driverBody = `El envío "${shipmentInfo?.title || 'Sin título'}" ha sido cancelado.`;
          break;
        default:
          driverBody = body;
      }

      await sendPush(driverTokens, driverTitle, driverBody);
    }

      logger.info('Notificaciones de actualización de estado enviadas', { 
        shipmentId, 
        status,
        ownerTokens: ownerTokens.length,
        driverTokens: driverTokens.length
      });
    }
  } catch (pushError) {
    logger.error('Error al enviar notificaciones push', pushError as Error, { shipmentId });
    // No fallamos por errores de notificaciones push
  }

  logger.info('Estado de envío actualizado', { shipmentId, status, userId: user.sub });
  res.json({ ok: true });
}));

// ✅ Obtener historial de estados
const GetStatusesParams = z.object({
  id: z.string().uuid('ID de envío inválido'),
});

router.get('/:id/statuses', validateParams(GetStatusesParams), asyncHandler(async (req, res) => {
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
    logger.error('Error al obtener historial de estados', error as Error, { shipmentId });
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'No se pudo obtener el historial' 
    });
    return;
  }

  res.json(data || []);
}));

export const shipmentRouter = router;