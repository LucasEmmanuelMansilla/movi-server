import { Router } from 'express';
import { createAdminClient } from '../lib/supabase';
import { StatusCodes } from 'http-status-codes';
import asyncHandler from 'express-async-handler';
import { sendPush } from './push';

const router = Router();

router.post('/send', asyncHandler(async (req, res) => {
  const user = req.user as { sub: string } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Unauthorized' });
    return;
  }

  const { shipment_id, receiver_id, content } = req.body as {
    shipment_id: string;
    receiver_id: string;
    content: string;
  };

  if (!shipment_id || !receiver_id || !content) {
    res.status(StatusCodes.BAD_REQUEST).json({ error: 'Missing required fields' });
    return;
  }

  const admin = createAdminClient();

  const { data: message, error: messageError } = await admin
    .from('messages')
    .insert({
      shipment_id,
      sender_id: user.sub,
      receiver_id,
      content,
    })
    .select('*, sender:profiles!messages_sender_id_fkey(full_name)')
    .single();

  if (messageError) {
    console.error('[Chat] Error al guardar mensaje:', messageError);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Failed to save message' });
    return;
  }

  const { data: tokens, error: tokensError } = await admin
    .from('push_tokens')
    .select('token')
    .eq('user_id', receiver_id);

  if (tokensError) {
    console.error('[Chat] Error al obtener tokens:', tokensError);
  } else if (tokens && tokens.length > 0) {
    const senderName = (message as any).sender?.full_name || 'Alguien';
    const pushTokens = tokens.map(t => t.token);
    
    await sendPush(
      pushTokens,
      `Nuevo mensaje de ${senderName}`,
      content,
      {
        type: 'chat',
        shipment_id,
        sender_id: user.sub,
      }
    );
  }

  res.status(StatusCodes.CREATED).json(message);
}));

router.post('/read', asyncHandler(async (req, res) => {
  const user = req.user as { sub: string } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Unauthorized' });
    return;
  }

  const { shipment_id, sender_id } = req.body as {
    shipment_id: string;
    sender_id: string;
  };

  const admin = createAdminClient();

  const { error } = await admin
    .from('messages')
    .update({ read_at: new Date().toISOString() })
    .eq('shipment_id', shipment_id)
    .eq('receiver_id', user.sub)
    .eq('sender_id', sender_id)
    .is('read_at', null);

  if (error) {
    console.error('[Chat] Error al marcar como leído:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Failed to mark as read' });
    return;
  }

  res.status(StatusCodes.OK).json({ success: true });
}));

export const chatRouter = router;
