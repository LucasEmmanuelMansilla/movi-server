import { Router } from 'express';
import { z } from 'zod';
import { createAdminClient, createUserClient } from '../lib/supabase';
import type { Role } from '../types';
import { StatusCodes } from 'http-status-codes';
import asyncHandler from 'express-async-handler';

const router = Router();

const ExchangeBody = z.object({
  access_token: z.string(),
  role: z.enum(['driver', 'business']).optional(),
  full_name: z.string().optional(),
  phone: z.string().optional(),
});

router.post('/exchange', asyncHandler(async (req, res) => {
  const parsed = ExchangeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(StatusCodes.BAD_REQUEST).json({ 
      error: 'Invalid body', 
      details: parsed.error.flatten() 
    });
    return;
  }
  
  const { access_token, role, full_name, phone } = parsed.data;

  console.log(`📥 Exchange request recibido - Rol: ${role || 'NO PROPORCIONADO'}, Nombre: ${full_name || 'N/A'}, Phone: ${phone || 'N/A'}`);

  try {
    const userClient = createUserClient(access_token);
    const { data: userRes, error: userErr } = await userClient.auth.getUser();
    
    if (userErr || !userRes.user) {
      console.error('❌ Error al obtener usuario:', userErr);
      res.status(StatusCodes.UNAUTHORIZED).json({ 
        error: 'Invalid Supabase access token' 
      });
      return;
    }
    
    const user = userRes.user;
    console.log(`👤 Usuario obtenido: ${user.email}, ID: ${user.id}`);
    console.log(`📋 User metadata:`, JSON.stringify(user.user_metadata || {}));
    
    const admin = createAdminClient();
    
    // Fetch existing profile
    const { data: prof, error: profErr } = await admin
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();

    if (profErr) {
      console.error('Error fetching profile:', profErr);
      throw new Error('Failed to fetch profile');
    }

    // Lógica mejorada para determinar el rol:
    // 1. Si se pasa un rol explícito en el request, tiene prioridad (especialmente en registro)
    // 2. Si no hay rol en el request, usar el del perfil existente
    // 3. Si no hay ni rol en request ni en perfil, usar 'business' por defecto
    let finalRole: Role;
    
    if (role) {
      // El rol del request tiene prioridad (viene del registro o actualización explícita)
      finalRole = role as Role;
      console.log(`✅ Usando rol del request: ${finalRole} para usuario ${user.id}`);
    } else if (prof?.role) {
      // Si no hay rol en el request, usar el del perfil existente
      finalRole = prof.role as Role;
      console.log(`ℹ️ Usando rol del perfil existente: ${finalRole} para usuario ${user.id}`);
    } else {
      // Por defecto, usar 'business' solo si no hay ninguna otra opción
      finalRole = 'business';
      console.log(`⚠️ Usando rol por defecto 'business' para usuario ${user.id} (no se encontró rol en request ni en perfil)`);
    }

    console.log(`💾 Guardando perfil - ID: ${user.id}, Rol final: ${finalRole}, Nombre: ${full_name ?? prof?.full_name ?? 'N/A'}`);
    
    const { error: upsertErr } = await admin.from('profiles').upsert({
      id: user.id,
      role: finalRole,
      full_name: full_name ?? prof?.full_name ?? null,
      phone: phone ?? prof?.phone ?? null,
    });

    if (upsertErr) {
      console.error('❌ Error upserting profile:', upsertErr);
      throw new Error('Failed to upsert profile');
    }
    
    console.log(`✅ Perfil guardado exitosamente con rol: ${finalRole}`);

    // Generate JWT token
    const token = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: user.email!,
      options: {
        redirectTo: 'movi://auth/callback',
      },
    });

    const response = {
      user: {
        id: user.id,
        email: user.email,
        role: finalRole,
        full_name: full_name ?? prof?.full_name,
        phone: phone ?? prof?.phone,
      },
      token: token.data.properties?.action_link,
    };
    
    console.log(`📤 Enviando respuesta del exchange - Rol: ${finalRole}, Email: ${user.email}`);
    
    res.status(StatusCodes.OK).json(response);
  } catch (error: any) {
    console.error('Error in auth exchange:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Authentication failed',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
}));

export const authRouter = router;
