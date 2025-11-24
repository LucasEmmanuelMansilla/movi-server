import { Router } from 'express';
import fetch from 'node-fetch';
import { createAdminClient } from '../lib/supabase';
import { StatusCodes } from 'http-status-codes';
import asyncHandler from 'express-async-handler';

const router = Router();

// Registrar o actualizar token de push para el usuario autenticado
router.post('/register', asyncHandler(async (req, res) => {
  const user = req.user as { sub: string } | undefined;
  if (!user?.sub) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Unauthorized' });
  }

  const { token, platform } = req.body as { token?: string; platform?: string };
  
  if (!token) {
    return res.status(StatusCodes.BAD_REQUEST).json({ 
      error: 'Token is required' 
    });
  }

  const admin = createAdminClient();
  
  try {
    // upsert por token único
    const { error } = await admin
      .from('push_tokens')
      .upsert({ 
        user_id: user.sub, 
        token, 
        platform: platform || null 
      });

    if (error) throw error;
    
    res.status(StatusCodes.NO_CONTENT).send();
  } catch (error) {
    console.error('Error registering push token:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'Failed to register push token' 
    });
  }
}));

// Utilidad para enviar notificaciones via Expo Push API
export async function sendPush(tokens: string[], title: string, body: string) {
  if (!tokens.length) return;
  
  const messages = tokens.map((to) => ({
    to,
    sound: 'default',
    title,
    body,
  }));

  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Authorization opcional si se tiene EXPO_ACCESS_TOKEN
        ...(process.env.EXPO_ACCESS_TOKEN 
          ? { 'Authorization': `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } 
          : {}
        ),
      },
      body: JSON.stringify(messages),
    });
  } catch (error) {
    console.error('Error sending push notification:', error);
    // No lanzamos el error para no romper el flujo principal
  }
}

export const pushRouter = router;
