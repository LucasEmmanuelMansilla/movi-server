import { Router } from 'express';
import { z } from 'zod';
import { createAdminClient, createUserClient } from '../lib/supabase';
import type { Role } from '../types';
import { StatusCodes } from 'http-status-codes';
import asyncHandler from 'express-async-handler';
import { logger } from '../utils/logger';
import { validateBody } from '../utils/validation';

const router = Router();

const ExchangeBody = z.object({
  access_token: z.string(),
  role: z.enum(['driver', 'business', 'admin']).optional(),
  full_name: z.string().optional(),
  phone: z.string().optional(),
  privacy_policy_accepted: z.boolean().optional(),
});

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

/**
 * POST /auth/login
 * Login para administradores
 */
router.post('/login', validateBody(LoginBody), asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const admin = createAdminClient();

  try {
    // Autenticar con Supabase usando service role
    const { data: authData, error: authError } = await admin.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (authError || !authData.user) {
      res.status(StatusCodes.UNAUTHORIZED).json({ 
        error: 'Email o contraseña incorrectos' 
      });
      return;
    }

    // Verificar que el usuario tenga rol de admin
    const { data: profile } = await admin
      .from('profiles')
      .select('role, full_name, phone')
      .eq('id', authData.user.id)
      .maybeSingle();

    if (!profile || profile.role !== 'admin') {
      res.status(StatusCodes.FORBIDDEN).json({ 
        error: 'Acceso denegado. Se requiere rol de administrador.' 
      });
      return;
    }

    // Generar token JWT usando el mismo método que exchange
    const token = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: authData.user.email!,
      options: {
        redirectTo: 'movi://auth/callback',
      },
    });

    // El token JWT real está en el access_token de la sesión
    const jwtToken = authData.session?.access_token;

    if (!jwtToken) {
      res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
        error: 'Error generando token de sesión' 
      });
      return;
    }

    res.status(StatusCodes.OK).json({
      token: jwtToken,
      user: {
        id: authData.user.id,
        email: authData.user.email,
        role: profile.role,
        full_name: profile.full_name,
        phone: profile.phone,
      },
    });
  } catch (error: any) {
    logger.error('Error en login', error as Error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Error al iniciar sesión',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
}));

router.post('/exchange', asyncHandler(async (req, res) => {
  const parsed = ExchangeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(StatusCodes.BAD_REQUEST).json({ 
      error: 'Invalid body', 
      details: parsed.error.flatten() 
    });
    return;
  }
  
  const { access_token, role, full_name, phone, privacy_policy_accepted } = parsed.data;

  try {
    const userClient = createUserClient(access_token);
    const { data: userRes, error: userErr } = await userClient.auth.getUser();
    
    if (userErr || !userRes.user) {
      res.status(StatusCodes.UNAUTHORIZED).json({ 
        error: 'Invalid Supabase access token' 
      });
      return;
    }
    
    const user = userRes.user;
    const admin = createAdminClient();
    
    const { data: prof, error: profErr } = await admin
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();

    if (profErr) {
      logger.error('Error fetching profile', profErr as Error);
      throw new Error('Failed to fetch profile');
    }

    let finalRole: Role;
    
    if (role) {
      finalRole = role as Role;
    } else if (prof?.role) {
      finalRole = prof.role as Role;
    } else {
      finalRole = 'business';
    }
    
    // Preparar datos para upsert
    const upsertData: any = {
      id: user.id,
      role: finalRole,
      full_name: full_name ?? prof?.full_name ?? null,
      phone: phone ?? prof?.phone ?? null,
    };

    if (privacy_policy_accepted === true) {
      const now = new Date().toISOString();
      upsertData.privacy_policy_accepted = true;
      upsertData.privacy_policy_accepted_at = now;
      upsertData.updated_at = now;
    }
    
    const { error: upsertErr } = await admin.from('profiles').upsert(upsertData);

    if (upsertErr) {
      logger.error('Error upserting profile', upsertErr as Error);
      throw new Error('Failed to upsert profile');
    }

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
    
    res.status(StatusCodes.OK).json(response);
  } catch (error: any) {
    logger.error('Error in auth exchange', error as Error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Authentication failed',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
}));

export const authRouter = router;
