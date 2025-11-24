import { Router } from 'express';
import { z } from 'zod';
import { createAdminClient } from '../lib/supabase';
import { StatusCodes } from 'http-status-codes';
import asyncHandler from 'express-async-handler';

const router = Router();

const UpdateProfileBody = z.object({
  full_name: z.string().min(1).max(120).optional(),
  phone: z.string().min(5).max(30).optional(),
});

// Obtener perfil del usuario autenticado
router.get('/me', asyncHandler(async (req, res) => {
  const user = req.user as { sub: string } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Unauthorized' });
    return;
  }

  const admin = createAdminClient();
  
  try {
    const { data, error } = await admin
      .from('profiles')
      .select('id, role, full_name, phone, created_at')
      .eq('id', user.sub)
      .maybeSingle();

    if (error) throw error;
    
    if (!data) {
      res.status(StatusCodes.NOT_FOUND).json({ 
        error: 'Profile not found' 
      });
      return;
    }

    res.json(data);
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'Failed to fetch profile' 
    });
  }
}));

// Actualizar nombre/telefono
router.put('/me', asyncHandler(async (req, res) => {
  const user = req.user as { sub: string } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Unauthorized' });
    return
  }

  const parsed = UpdateProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(StatusCodes.BAD_REQUEST).json({ 
      error: 'Invalid data', 
      details: parsed.error.flatten() 
    });
    return;
  }

  const { full_name, phone } = parsed.data;
  const admin = createAdminClient();

  try {
    const { data, error } = await admin
      .from('profiles')
      .update({ 
        full_name: full_name ?? null, 
        phone: phone ?? null,
        updated_at: new Date().toISOString()
      })
      .eq('id', user.sub)
      .select('id, role, full_name, phone, created_at')
      .maybeSingle();

    if (error) throw error;
    
    if (!data) {
      res.status(StatusCodes.NOT_FOUND).json({ 
        error: 'Profile not found' 
      });
      return;
    }

    res.json(data);
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'Failed to update profile' 
    });
    return;
  }
}));

export const profileRouter = router;
