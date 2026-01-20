import { Router } from 'express';
import { z } from 'zod';
import { createAdminClient } from '../lib/supabase';
import type { Role, ShipmentStatus } from '../types';
import type { TablesUpdate } from '../supabase.types';
import { sendPush } from './push';
import { StatusCodes } from 'http-status-codes';
import asyncHandler from 'express-async-handler';
import { logger } from '../utils/logger';
import { titleSchema, descriptionSchema, addressSchema, priceSchema, weightSchema, validateBody, validateQuery, validateParams } from '../utils/validation';
import { parseAddressWithCoordinates, geocodeAddress, filterNearbyUsers, calculateDistance } from '../utils/geolocation';

// Constantes para el cálculo de precios
const PRICE_PER_KM = 500; // $500 por kilómetro
const PRICE_PER_KG = 200; // $200 por kilogramo
const BASE_PRICE = 1000; // Precio base

const router = Router();

const CreateShipmentBody = z.object({
  title: titleSchema,
  description: descriptionSchema,
  pickup_address: addressSchema,
  dropoff_address: addressSchema,
  weight: weightSchema,
  location: z.object({
    coords: z.object({
      accuracy: z.number(),
      altitude: z.number(),
      altitudeAccuracy: z.number(),
      heading: z.number(),
      latitude: z.number(),
      longitude: z.number(),
      speed: z.number(),
    }),
    mocked: z.boolean(),
    timestamp: z.number(),
  }).optional(),
  dropoffLocation: z.object({
    coords: z.object({
      accuracy: z.number(),
      altitude: z.number(),
      altitudeAccuracy: z.number(),
      heading: z.number(),
      latitude: z.number(),
      longitude: z.number(),
      speed: z.number(),
    }),
    mocked: z.boolean(),
    timestamp: z.number(),
  }).optional(),
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

  // Obtener coordenadas de retiro: prioridad 1 = location.coords, 2 = pickup_address parseado, 3 = geocodificar
  let pickupLat: number | undefined;
  let pickupLng: number | undefined;
  let pickupAddress: string = body.pickup_address; // Dirección formateada para notificaciones

  if (body.location?.coords) {
    pickupLat = body.location.coords.latitude;
    pickupLng = body.location.coords.longitude;
    // Parsear la dirección para obtener el formato correcto
    const parsedPickup = parseAddressWithCoordinates(body.pickup_address);
    pickupAddress = parsedPickup.address;
  } else {
    const parsedPickup = parseAddressWithCoordinates(body.pickup_address);
    pickupAddress = parsedPickup.address;
    pickupLat = parsedPickup.lat;
    pickupLng = parsedPickup.lng;

    if (!pickupLat || !pickupLng) {
      try {
        const coords = await geocodeAddress(parsedPickup.address);
        if (coords) {
          pickupLat = coords.lat;
          pickupLng = coords.lng;
        }
      } catch (geocodeError) {
        logger.warn('Error geocodificando dirección de pickup', { error: geocodeError });
      }
    }
  }

  // Obtener coordenadas de entrega
  let dropoffLat: number | undefined;
  let dropoffLng: number | undefined;

  if (body.dropoffLocation?.coords) {
    dropoffLat = body.dropoffLocation.coords.latitude;
    dropoffLng = body.dropoffLocation.coords.longitude;
  } else {
    // Intentar geocodificar la dirección de entrega
    try {
      const coords = await geocodeAddress(body.dropoff_address);
      if (coords) {
        dropoffLat = coords.lat;
        dropoffLng = coords.lng;
      }
    } catch (geocodeError) {
      logger.warn('Error geocodificando dirección de dropoff', { error: geocodeError });
    }
  }

  // Calcular precio automáticamente basado en distancia y peso
  let calculatedPrice: number | null = null;
  if (pickupLat && pickupLng && dropoffLat && dropoffLng) {
    const distance = calculateDistance(pickupLat, pickupLng, dropoffLat, dropoffLng);

    // Fórmula de cálculo: precio base + (distancia_km * precio_por_km) + (peso_kg * factor_peso)
    calculatedPrice = BASE_PRICE + (distance * PRICE_PER_KM) + (body.weight * PRICE_PER_KG);
    calculatedPrice = Math.round(calculatedPrice);
  } else {
    // Si no se pueden obtener coordenadas, usar un precio estimado basado solo en peso
    calculatedPrice = BASE_PRICE + (body.weight * PRICE_PER_KG);
  }

  // Crear envío en estado "draft" (borrador) - no se publica hasta que se pague
  // Guardar dirección con coordenadas si están disponibles para evitar geocodificación posterior
  const finalPickupAddress = pickupLat && pickupLng
    ? JSON.stringify({ address: pickupAddress, lat: pickupLat, lng: pickupLng })
    : body.pickup_address;

  const finalDropoffAddress = dropoffLat && dropoffLng
    ? JSON.stringify({ address: body.dropoff_address, lat: dropoffLat, lng: dropoffLng })
    : body.dropoff_address;

  const { data, error } = await admin
    .from('shipments')
    .insert({
      title: body.title,
      description: body.description ?? null,
      pickup_address: finalPickupAddress,
      dropoff_address: finalDropoffAddress,
      price: calculatedPrice,
      weight: body.weight,
      created_by: user.sub,
      current_status: 'draft', // Estado borrador, se publicará después del pago
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

  // NO notificar a drivers todavía - el envío está en draft y requiere pago primero
  logger.info('Envío creado en estado draft (requiere pago)', {
    shipmentId: data.id,
    userId: user.sub,
    calculatedPrice
  });
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
      // Solo mostrar envíos publicados (created), no los borradores (draft)
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
          .select('*, driver_assignments(driver_id)')
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
          .select('*, driver_assignments(driver_id)')
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

const AcceptShipmentBody = z.object({
  location: z.object({
    coords: z.object({
      accuracy: z.number(),
      altitude: z.number(),
      altitudeAccuracy: z.number(),
      heading: z.number(),
      latitude: z.number(),
      longitude: z.number(),
      speed: z.number(),
    }),
    mocked: z.boolean(),
    timestamp: z.number(),
  }).optional(),
});

router.post('/:id/accept', validateParams(AcceptShipmentParams), validateBody(AcceptShipmentBody), asyncHandler(async (req, res) => {
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
    .select('role, full_name, phone, license_number, vehicle_type, vehicle_plate')
    .eq('id', user.sub)
    .maybeSingle();

  if (!profile || profile.role !== 'driver') {
    res.status(StatusCodes.FORBIDDEN).json({
      error: 'Only drivers can accept shipments'
    });
    return;
  }

  // 🛡️ VERIFICACIÓN DE PERFIL COMPLETO
  const isProfileComplete =
    profile.full_name &&
    profile.phone &&
    profile.license_number &&
    profile.vehicle_type &&
    profile.vehicle_plate;

  if (!isProfileComplete) {
    res.status(StatusCodes.FORBIDDEN).json({
      error: 'Debes completar tu perfil para aceptar envíos.',
      details: {
        missing_fields: [
          !profile.full_name && 'Nombre completo',
          !profile.phone && 'Teléfono',
          !profile.license_number && 'Número de licencia',
          !profile.vehicle_type && 'Tipo de vehículo',
          !profile.vehicle_plate && 'Patente del vehículo'
        ].filter(Boolean)
      }
    });
    return;
  }

  const { data: shipment } = await admin
    .from('shipments')
    .select('id, current_status, created_by, price')
    .eq('id', shipmentId)
    .maybeSingle();

  if (!shipment) {
    res.status(StatusCodes.NOT_FOUND).json({ error: 'Shipment not found' });
    return;
  }

  // Solo se pueden aceptar envíos en estado "created" (publicados)
  if (shipment.current_status !== 'created') {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Shipment not available'
    });
    return;
  }

  // Verificar que el pago esté aprobado si el envío tiene precio
  if (shipment.price && shipment.price > 0) {
    const { data: payment } = await admin
      .from('payments')
      .select('id, status')
      .eq('shipment_id', shipmentId)
      .eq('status', 'approved')
      .maybeSingle();

    if (!payment) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: 'El pago debe estar aprobado antes de aceptar el envío'
      });
      return;
    }
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

  // Actualizar el driver_id en la tabla de pagos para que el pago esté vinculado al conductor
  // Esto es necesario para que el frontend pueda procesar transferencias y mostrar información correcta
  try {
    const { error: pErr } = await admin
      .from('payments')
      .update({ driver_id: user.sub })
      .eq('shipment_id', shipmentId);

    if (pErr) {
      logger.warn('No se pudo actualizar el driver_id en el pago', { error: pErr, shipmentId, driverId: user.sub });
    } else {
      logger.info('Pago vinculado al conductor exitosamente', { shipmentId, driverId: user.sub });
    }
  } catch (err) {
    logger.warn('Error al intentar vincular el pago al conductor', { error: err, shipmentId });
  }

  await admin.from('shipment_statuses').insert({
    shipment_id: shipmentId,
    status: 'assigned',
    note: 'Driver assigned',
    created_by: user.sub
  });

  // Notificar a todos los drivers que el envío ya no está disponible
  try {
    const shipmentChannel = admin.channel('global:shipments');
    await shipmentChannel.send({
      type: 'broadcast',
      event: 'shipment_updated',
      payload: { shipmentId, status: 'assigned' }
    });
  } catch (err) {
    logger.warn('Error enviando broadcast de asignación', { error: err });
  }

  // Actualizar ubicación del driver si se proporciona
  if (req.body.location?.coords) {
    try {
      const updateData: TablesUpdate<'profiles'> = {
        latitude: req.body.location.coords.latitude,
        longitude: req.body.location.coords.longitude,
        last_location_updated: new Date().toISOString(),
      };
      await admin
        .from('profiles')
        .update(updateData)
        .eq('id', user.sub);
      logger.info('Ubicación del driver actualizada al aceptar envío', { driverId: user.sub, shipmentId });
    } catch (locationError) {
      logger.warn('Error al actualizar ubicación del driver', { error: locationError, driverId: user.sub });
      // No fallamos si hay error al actualizar ubicación
    }
  }

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
  status: z.enum(['picked_up', 'in_transit', 'ready_for_delivery', 'delivered', 'cancelled']),
  note: z.string().max(500).optional(),
  location: z.object({
    coords: z.object({
      accuracy: z.number(),
      altitude: z.number(),
      altitudeAccuracy: z.number(),
      heading: z.number(),
      latitude: z.number(),
      longitude: z.number(),
      speed: z.number(),
    }),
    mocked: z.boolean(),
    timestamp: z.number(),
  }).optional(),
});

router.post('/:id/status', validateParams(UpdateStatusParams), validateBody(UpdateStatusBody), asyncHandler(async (req, res) => {
  const user = req.user as { sub: string } | undefined;
  if (!user?.sub) {
    logger.warn('Intento de actualizar estado sin autenticación');
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  const shipmentId = req.params.id;
  const { status, note, location } = req.body;
  const admin = createAdminClient();

  // Obtener información del envío con direcciones
  const { data: shipment, error: shipError } = await admin
    .from('shipments')
    .select('id, created_by, current_status, pickup_address, dropoff_address')
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

  // 🛡️ Solo el dueño (Business) puede confirmar la entrega
  if (status === 'delivered' && !isOwner) {
    res.status(StatusCodes.FORBIDDEN).json({
      error: 'Solo el autor del envío puede confirmar la entrega.'
    });
    return;
  }

  // 🛡️ El conductor NO puede marcar como entregado
  if (isDriver && status === 'delivered') {
    res.status(StatusCodes.FORBIDDEN).json({
      error: 'No tienes permiso para marcar este envío como entregado. El cliente debe confirmar la recepción.'
    });
    return;
  }

  // Validar ubicación para drivers cuando cambian a 'picked_up'
  if (isDriver && status === 'picked_up') {
    if (!location?.coords) {
      res.status(StatusCodes.BAD_REQUEST).json({
        error: 'Se requiere la ubicación actual para cambiar este estado'
      });
      return;
    }

    const driverLat = location.coords.latitude;
    const driverLng = location.coords.longitude;
    const MAX_DISTANCE_KM = 0.5; // Aumentar a 500 metros para evitar falsos negativos por GPS

    if (status === 'picked_up') {
      // Validar que el driver esté cerca de la dirección de retiro
      // ✅ MEJORA: Usar coordenadas si ya están persistidas en el address JSON
      const parsedPickup = parseAddressWithCoordinates(shipment.pickup_address);
      let pickupCoords: { lat: number; lng: number } | null = null;

      if (parsedPickup.lat && parsedPickup.lng) {
        pickupCoords = { lat: parsedPickup.lat, lng: parsedPickup.lng };
      } else {
        pickupCoords = await geocodeAddress(parsedPickup.address);
      }

      if (!pickupCoords) {
        logger.warn('No se pudo geocodificar dirección de retiro para validación', { shipmentId });
        // Continuar sin validación si no se puede geocodificar para evitar bloquear el flujo
      } else {
        const distance = calculateDistance(driverLat, driverLng, pickupCoords.lat, pickupCoords.lng);
        if (distance > MAX_DISTANCE_KM) {
          res.status(StatusCodes.BAD_REQUEST).json({
            error: `Debes estar en el radio de 500 metros del punto de retiro para marcar como recogido. Estás a ${(distance * 1000).toFixed(0)} metros de distancia.`
          });
          return;
        }
      }
    }
  }

  // 🛡️ REGLAS DE NEGOCIO PARA DOBLE CHECK (Driver -> Ready -> Business -> Delivered)
  if (status === 'ready_for_delivery') {
    if (!isDriver) {
      res.status(StatusCodes.FORBIDDEN).json({ error: 'Solo el conductor puede notificar la entrega.' });
      return;
    }
    if (shipment.current_status !== 'in_transit') {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'El envío debe estar en tránsito para marcar como por entregar.' });
      return;
    }
  }

  if (status === 'delivered') {
    if (!isOwner) {
      res.status(StatusCodes.FORBIDDEN).json({ error: 'Solo el cliente puede confirmar la recepción final.' });
      return;
    }
    if (shipment.current_status !== 'ready_for_delivery') {
      res.status(StatusCodes.BAD_REQUEST).json({ error: 'El conductor debe marcar el pedido como entregado antes de que puedas confirmarlo.' });
      return;
    }
  }

  // Si el estado es 'delivered', antes se procesaba la transferencia automática.
  // AHORA: Se elimina la transferencia automática para permitir retiro manual por el driver.
  if (status === 'delivered' && assign?.driver_id) {
    logger.info('Envío entregado. El conductor ahora puede retirar su pago manualmente.', {
      shipmentId,
      driverId: assign.driver_id
    });

    // Asegurarse de que el pago tenga el driver_id vinculado
    try {
      const { data: payment } = await admin
        .from('payments')
        .select('id, driver_id')
        .eq('shipment_id', shipmentId)
        .eq('status', 'approved')
        .maybeSingle();

      if (payment && !payment.driver_id) {
        await admin
          .from('payments')
          .update({ driver_id: assign.driver_id })
          .eq('id', payment.id);
        logger.info('Pago vinculado al conductor correctamente', { shipmentId, paymentId: payment.id });
      }
    } catch (err) {
      logger.error('Error vinculando driver al pago en entrega', err as Error);
    }
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

  // Emitir actualización en tiempo real a business y driver (si existen)
  try {
    const businessId = shipment.created_by;
    const driverId = assign?.driver_id ?? null;
    const targets = [businessId, driverId].filter(Boolean) as string[];

    await Promise.allSettled(
      targets.map(async (userId) => {
        const channel = admin.channel(`user:${userId}`);
        try {
          await channel.send({
            type: 'broadcast',
            event: 'shipment_status_changed',
            payload: { shipmentId, status },
          });
        } finally {
          admin.removeChannel(channel);
        }
      })
    );
  } catch (err) {
    logger.warn('Error enviando broadcast shipment_status_changed', { error: err, shipmentId, status });
  }

  // Obtener información del envío para las notificaciones
  const { data: shipmentInfo } = await admin
    .from('shipments')
    .select('title, pickup_address, dropoff_address')
    .eq('id', shipmentId)
    .single();

  // Notificar a los usuarios relevantes con mensajes específicos según el estado
  // IMPORTANTE: Si el driver actualiza el estado, solo notificar al business owner (NO al driver)
  // Si el business owner actualiza el estado, solo notificar al driver
  try {
    // Determinar a quién notificar basado en quién hizo el cambio
    let userIdToNotify: string | null = null;

    if (isDriver) {
      // Si el driver actualiza el estado, solo notificar al business owner
      userIdToNotify = shipment.created_by;
    } else if (isOwner && assign?.driver_id) {
      // Si el business owner actualiza el estado, notificar al driver
      userIdToNotify = assign.driver_id;
    }

    if (!userIdToNotify) {
      logger.info('No hay usuarios para notificar', { shipmentId, status, isDriver, isOwner });
    } else {
      const { data: tokens } = await admin
        .from('push_tokens')
        .select('token')
        .eq('user_id', userIdToNotify);

      if (!tokens || tokens.length === 0) {
        logger.info('No hay tokens de push disponibles para notificar', {
          shipmentId,
          userId: userIdToNotify
        });
      } else {
        const pushTokens = tokens.map(t => t.token);

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
          case 'ready_for_delivery':
            title = 'Pedido por confirmar';
            body = `El conductor indica que ya entregó "${shipmentInfo?.title || 'Sin título'}". Por favor confirma la recepción para finalizar.`;
            break;
          case 'delivered':
            title = 'Envío finalizado';
            body = `El cliente ha confirmado la recepción de "${shipmentInfo?.title || 'Sin título'}". ¡Buen trabajo!`;
            break;
          case 'cancelled':
            title = 'Envío cancelado';
            body = `El envío "${shipmentInfo?.title || 'Sin título'}" ha sido cancelado.`;
            break;
          default:
            body = `Nuevo estado: ${status}`;
        }

        // ✅ MEJORA: No esperar a que se envíe el push para responder al cliente (evita timeouts)
        sendPush(pushTokens, title, body, {
          type: 'shipment_status_changed',
          shipmentId,
          status,
        }).catch(e => {
          logger.error('Error enviando push en background', e as Error, { shipmentId });
        });

        logger.info('Notificación de actualización de estado encolada', {
          shipmentId,
          status,
          updatedBy: isDriver ? 'driver' : 'owner',
          notifiedUserId: userIdToNotify
        });
      }
    }
  } catch (pushError) {
    logger.error('Error al preparar notificaciones push', pushError as Error, { shipmentId });
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