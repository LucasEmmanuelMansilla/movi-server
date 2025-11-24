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

    let finalRole: Role | undefined = prof?.role as Role | undefined;
    if (!finalRole) finalRole = (role as Role) || 'business';

    const { error: upsertErr } = await admin.from('profiles').upsert({
      id: user.id,
      role: finalRole,
      full_name: full_name ?? prof?.full_name ?? null,
      phone: phone ?? prof?.phone ?? null,
    });

    if (upsertErr) {
      console.error('Error upserting profile:', upsertErr);
      throw new Error('Failed to upsert profile');
    }

    // Generate JWT token
    const token = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: user.email!,
      options: {
        redirectTo: 'movi://auth/callback',
      },
    });

    res.status(StatusCodes.OK).json({
      user: {
        id: user.id,
        email: user.email,
        role: finalRole,
        full_name: full_name ?? prof?.full_name,
        phone: phone ?? prof?.phone,
      },
      token: token.data.properties?.action_link,
    });
  } catch (error: any) {
    console.error('Error in auth exchange:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({
      error: 'Authentication failed',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
}));

export const authRouter = router;
