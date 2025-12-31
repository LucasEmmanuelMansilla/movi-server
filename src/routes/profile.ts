import { Router } from 'express';
import { z } from 'zod';
import { createAdminClient } from '../lib/supabase';
import { StatusCodes } from 'http-status-codes';
import asyncHandler from 'express-async-handler';
import {
  fullNameSchema,
  phoneSchema,
  emailSchema,
  addressSchema,
  avatarUrlSchema,
  licenseNumberSchema,
  vehicleTypeSchema,
  vehiclePlateSchema,
  businessNameSchema,
  cbuSchema,
  cvuSchema,
  aliasSchema,
  bankNameSchema,
  accountNumberSchema,
  accountTypeSchema,
} from '../utils/validation';

const router = Router();

const UpdateProfileBody = z.object({
  full_name: fullNameSchema.optional(),
  phone: phoneSchema.optional(),
  email: emailSchema.optional(),
  avatar_url: avatarUrlSchema,
  address: addressSchema.optional(),
  // Campos específicos para drivers
  license_number: licenseNumberSchema,
  vehicle_type: vehicleTypeSchema,
  vehicle_plate: vehiclePlateSchema,
  is_available: z.boolean().optional(),
  // Campos bancarios (para drivers)
  bank_account_type: accountTypeSchema,
  bank_cbu: cbuSchema,
  bank_cvu: cvuSchema,
  bank_alias: aliasSchema,
  bank_name: bankNameSchema,
  bank_account_number: accountNumberSchema,
  bank_account_holder_name: fullNameSchema.optional(), // Nombre del titular de la cuenta
  // Campos específicos para business
  business_name: businessNameSchema,
  business_address: addressSchema.optional(),
});

// Obtener perfil del usuario autenticado
router.get('/me', asyncHandler(async (req, res) => {
  const user = req.user as { sub: string; email?: string } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Unauthorized' });
    return;
  }

  const admin = createAdminClient();
  
  try {
    // Intentar seleccionar todos los campos (incluyendo los nuevos)
    // Si algunos campos no existen, Supabase los omitirá automáticamente
    const { data, error } = await admin
      .from('profiles')
      .select('id, role, full_name, phone, email, avatar_url, address, license_number, vehicle_type, vehicle_plate, is_available, business_name, business_address, bank_account_type, bank_cbu, bank_cvu, bank_alias, bank_name, bank_account_number, bank_account_holder_name, created_at, updated_at')
      .eq('id', user.sub)
      .maybeSingle();

    if (error) {
      // Si el error es por columnas que no existen, intentar con campos básicos
      if (error.code === '42703' || error.message?.includes('does not exist')) {
        const { data: basicData, error: basicError } = await admin
          .from('profiles')
          .select('id, role, full_name, phone, created_at')
          .eq('id', user.sub)
          .maybeSingle();
        
        if (basicError) throw basicError;
        if (!basicData) {
          res.status(StatusCodes.NOT_FOUND).json({ 
            error: 'Profile not found' 
          });
          return;
        }

        // Construir respuesta con campos básicos + campos nuevos como null
        const response = {
          ...basicData,
          email: user.email || null,
          avatar_url: null,
          address: null,
          license_number: null,
          vehicle_type: null,
          vehicle_plate: null,
          is_available: null,
          business_name: null,
          business_address: null,
          bank_account_type: null,
          bank_cbu: null,
          bank_cvu: null,
          bank_alias: null,
          bank_name: null,
          bank_account_number: null,
          bank_account_holder_name: null,
          updated_at: null,
        };
        res.json(response);
        return;
      }
      throw error;
    }
    
    if (!data) {
      res.status(StatusCodes.NOT_FOUND).json({ 
        error: 'Profile not found' 
      });
      return;
    }

    // Si el email no viene de la BD, obtenerlo del JWT
    const response = {
      ...(data as Record<string, any>),
      email: (data as Record<string, any>).email || user.email || null,
    };

    res.json(response);
  } catch (error) {
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'Failed to fetch profile' 
    });
  }
}));

// Actualizar perfil
router.put('/me', asyncHandler(async (req, res) => {
  const user = req.user as { sub: string } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Unauthorized' });
    return;
  }

  const parsed = UpdateProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(StatusCodes.BAD_REQUEST).json({ 
      error: 'Invalid data', 
      details: parsed.error.flatten() 
    });
    return;
  }

  const updateData = parsed.data;
  const admin = createAdminClient();
  const userWithEmail = req.user as { sub: string; email?: string };

  // Construir objeto de actualización con todos los campos disponibles
  const updateFields: Record<string, any> = {};

  // Campos básicos (siempre disponibles)
  if (updateData.full_name !== undefined) updateFields.full_name = updateData.full_name || null;
  if (updateData.phone !== undefined) updateFields.phone = updateData.phone || null;
  
  // Campos nuevos (se guardarán si existen en la BD)
  if (updateData.email !== undefined) updateFields.email = updateData.email || null;
  if (updateData.avatar_url !== undefined) updateFields.avatar_url = updateData.avatar_url || null;
  if (updateData.address !== undefined) updateFields.address = updateData.address || null;
  
  // Campos específicos para drivers
  if (updateData.license_number !== undefined) updateFields.license_number = updateData.license_number || null;
  if (updateData.vehicle_type !== undefined) updateFields.vehicle_type = updateData.vehicle_type || null;
  if (updateData.vehicle_plate !== undefined) updateFields.vehicle_plate = updateData.vehicle_plate || null;
  if (updateData.is_available !== undefined) updateFields.is_available = updateData.is_available;
  
  // Campos bancarios (para drivers)
  if (updateData.bank_account_type !== undefined) updateFields.bank_account_type = updateData.bank_account_type || null;
  if (updateData.bank_cbu !== undefined) updateFields.bank_cbu = updateData.bank_cbu || null;
  if (updateData.bank_cvu !== undefined) updateFields.bank_cvu = updateData.bank_cvu || null;
  if (updateData.bank_alias !== undefined) updateFields.bank_alias = updateData.bank_alias || null;
  if (updateData.bank_name !== undefined) updateFields.bank_name = updateData.bank_name || null;
  if (updateData.bank_account_number !== undefined) updateFields.bank_account_number = updateData.bank_account_number || null;
  if (updateData.bank_account_holder_name !== undefined) updateFields.bank_account_holder_name = updateData.bank_account_holder_name || null;
  
  // Campos específicos para business
  if (updateData.business_name !== undefined) updateFields.business_name = updateData.business_name || null;
  if (updateData.business_address !== undefined) updateFields.business_address = updateData.business_address || null;

  // Agregar updated_at si el campo existe
  updateFields.updated_at = new Date().toISOString();

  try {
    // Si no hay campos para actualizar, solo devolver el perfil actual
    if (Object.keys(updateFields).length === 0) {
      const { data: currentData } = await admin
        .from('profiles')
        .select('id, role, full_name, phone, email, avatar_url, address, license_number, vehicle_type, vehicle_plate, is_available, business_name, business_address, bank_account_type, bank_cbu, bank_cvu, bank_alias, bank_name, bank_account_number, bank_account_holder_name, created_at, updated_at')
        .eq('id', user.sub)
        .maybeSingle();
      
      if (!currentData) {
        res.status(StatusCodes.NOT_FOUND).json({ 
          error: 'Profile not found' 
        });
        return;
      }

      const response = {
        ...(currentData as Record<string, any>),
        email: (currentData as Record<string, any>).email || userWithEmail.email || null,
      };
      
      res.json(response);
      return;
    }

    // Intentar actualizar con todos los campos
    let data: any;
    let error: any;

    try {
      const result = await admin
        .from('profiles')
        .update(updateFields)
        .eq('id', user.sub)
        .select('id, role, full_name, phone, email, avatar_url, address, license_number, vehicle_type, vehicle_plate, is_available, business_name, business_address, bank_account_type, bank_cbu, bank_cvu, bank_alias, bank_name, bank_account_number, bank_account_holder_name, created_at, updated_at')
        .maybeSingle();
      
      data = result.data;
      error = result.error;
    } catch (updateError: any) {
      // Si falla por campos que no existen, intentar solo con campos básicos
      if (updateError.code === '42703' || updateError.message?.includes('does not exist')) {
        
        const basicUpdateFields: Record<string, any> = {};
        if (updateData.full_name !== undefined) basicUpdateFields.full_name = updateData.full_name || null;
        if (updateData.phone !== undefined) basicUpdateFields.phone = updateData.phone || null;
        
        if (Object.keys(basicUpdateFields).length === 0) {
          // No hay campos básicos para actualizar, devolver perfil actual
          const { data: currentData } = await admin
            .from('profiles')
            .select('id, role, full_name, phone, created_at')
            .eq('id', user.sub)
            .maybeSingle();
          
          if (!currentData) {
            res.status(StatusCodes.NOT_FOUND).json({ 
              error: 'Profile not found' 
            });
            return;
          }

          const response = {
            ...currentData,
            email: userWithEmail.email || null,
            avatar_url: null,
            address: null,
            license_number: null,
            vehicle_type: null,
            vehicle_plate: null,
            is_available: null,
            business_name: null,
            business_address: null,
            bank_account_type: null,
            bank_cbu: null,
            bank_cvu: null,
            bank_alias: null,
            bank_name: null,
            bank_account_number: null,
            bank_account_holder_name: null,
            updated_at: null,
          };
          
          res.json(response);
          return;
        }

        const result = await admin
          .from('profiles')
          .update(basicUpdateFields)
          .eq('id', user.sub)
          .select('id, role, full_name, phone, created_at')
          .maybeSingle();
        
        if (result.error) throw result.error;
        
        if (!result.data) {
          res.status(StatusCodes.NOT_FOUND).json({ 
            error: 'Profile not found' 
          });
          return;
        }

        // Construir respuesta con campos básicos + campos nuevos como null
        const response = {
          ...result.data,
          email: userWithEmail.email || null,
          avatar_url: null,
          address: null,
          license_number: null,
          vehicle_type: null,
          vehicle_plate: null,
          is_available: null,
          business_name: null,
          business_address: null,
          updated_at: null,
        };
        
        res.json(response);
        return;
      } else {
        throw updateError;
      }
    }

    if (error) throw error;
    
    if (!data) {
      res.status(StatusCodes.NOT_FOUND).json({ 
        error: 'Profile not found' 
      });
      return;
    }

    // Construir respuesta completa
    // Si data tiene todos los campos, usarlos; si no, completar con null
    const response = {
      ...data,
      // Asegurar que el email esté presente
      email: (data as any).email || userWithEmail.email || null,
      // Si faltan campos nuevos, agregarlos como null
      avatar_url: (data as any).avatar_url ?? null,
      address: (data as any).address ?? null,
      license_number: (data as any).license_number ?? null,
      vehicle_type: (data as any).vehicle_type ?? null,
      vehicle_plate: (data as any).vehicle_plate ?? null,
      is_available: (data as any).is_available ?? null,
      business_name: (data as any).business_name ?? null,
      business_address: (data as any).business_address ?? null,
      bank_account_type: (data as any).bank_account_type ?? null,
      bank_cbu: (data as any).bank_cbu ?? null,
      bank_cvu: (data as any).bank_cvu ?? null,
      bank_alias: (data as any).bank_alias ?? null,
      bank_name: (data as any).bank_name ?? null,
      bank_account_number: (data as any).bank_account_number ?? null,
      bank_account_holder_name: (data as any).bank_account_holder_name ?? null,
      updated_at: (data as any).updated_at ?? null,
    };

    res.json(response);
  } catch (error) {
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'Failed to update profile' 
    });
    return;
  }
}));

// Actualizar ubicación del driver (lat/lng)
const UpdateLocationBody = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

router.post('/me/location', asyncHandler(async (req, res) => {
  const user = req.user as { sub: string } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Unauthorized' });
    return;
  }

  const parsed = UpdateLocationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(StatusCodes.BAD_REQUEST).json({ 
      error: 'Invalid data', 
      details: parsed.error.flatten() 
    });
    return;
  }

  const { latitude, longitude } = parsed.data;
  const admin = createAdminClient();

  // Verificar que el usuario sea un driver
  const { data: profile } = await admin
    .from('profiles')
    .select('role')
    .eq('id', user.sub)
    .maybeSingle();

  if (!profile || profile.role !== 'driver') {
    res.status(StatusCodes.FORBIDDEN).json({ 
      error: 'Only drivers can update location' 
    });
    return;
  }

  // Actualizar ubicación (usar campos que existan en la BD)
  const updateFields: Record<string, any> = {
    latitude,
    longitude,
    last_location_updated: new Date().toISOString(),
  };

  try {
    const { error } = await admin
      .from('profiles')
      .update(updateFields)
      .eq('id', user.sub);

    if (error) {
    }

    res.status(StatusCodes.NO_CONTENT).send();
  } catch (error) {
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'Failed to update location' 
    });
  }
}));

export const profileRouter = router;
