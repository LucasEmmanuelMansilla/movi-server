import { Router } from 'express';
import { z } from 'zod';
import { createAdminClient } from '../lib/supabase';
import { MercadoPagoService } from '../services/mercadopago.service';
import { TokenRepository } from '../repositories/token.repository';
import { StatusCodes } from 'http-status-codes';
import asyncHandler from 'express-async-handler';
import { logger } from '../utils/logger';
import { validateQuery } from '../utils/validation';
import { authMiddleware } from '../middleware/auth';
import { env } from '../env';

const router = Router();
const mpService = MercadoPagoService.getInstance();
const tokenRepo = TokenRepository.getInstance();

/**
 * GET /mp/oauth/url
 * Obtiene la URL de OAuth de Mercado Pago, incluyendo el userId en el state
 */
router.get('/oauth/url', authMiddleware, asyncHandler(async (req, res) => {
  const user = req.user;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  const applicationId = env.MP_APPLICATION_ID || env.MP_CLIENT_ID;
  const redirectUri = env.MP_REDIRECT_URI;

  if (!applicationId || !redirectUri) {
    res.status(StatusCodes.SERVICE_UNAVAILABLE).json({ 
      error: 'OAuth de Mercado Pago no está configurado.'
    });
    return;
  }

  // Encriptar el userId para usarlo como state
  const state = tokenRepo.encrypt(user.sub);
  const encodedRedirectUri = encodeURIComponent(redirectUri);
  
  const oauthUrl = `https://auth.mercadopago.com.ar/authorization?client_id=${applicationId}&response_type=code&platform_id=mp&redirect_uri=${encodedRedirectUri}&state=${encodeURIComponent(state)}`;

  res.status(StatusCodes.OK).json({ oauth_url: oauthUrl });
}));

/**
 * GET /mp/oauth/callback
 * Callback de OAuth de Mercado Pago
 */
const OAuthCallbackQuery = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

router.get('/oauth/callback', validateQuery(OAuthCallbackQuery), asyncHandler(async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error || !code || !state) {
    logger.warn('Error o falta de datos en callback de OAuth', { error, code, state });
    const message = error_description || 'No se recibió el código o estado de autorización';
    return res.redirect(`movi://mp/oauth/error?error=${encodeURIComponent(error as string || 'missing_data')}&error_description=${encodeURIComponent(message as string)}`);
  }

  try {
    // 1. Recuperar el userId del state
    const userId = tokenRepo.decrypt(state as string);
    if (!userId) throw new Error('Estado de autorización inválido');

    // 2. Intercambiar código por tokens
    const tokenResponse = await mpService.exchangeOAuthCode(code as string);

    // 3. Obtener info del usuario de MP
    const mpUser = await mpService.getMercadoPagoUser(tokenResponse.access_token);

    // 4. Guardar en DB
    const admin = createAdminClient();
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + tokenResponse.expires_in);

    const { error: updateError } = await admin
      .from('profiles')
      .update({
        mp_user_id: mpUser.id.toString(),
        mp_access_token: tokenRepo.encrypt(tokenResponse.access_token),
        mp_refresh_token: tokenRepo.encrypt(tokenResponse.refresh_token),
        mp_token_expires_at: expiresAt.toISOString(),
        mp_status: 'connected',
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId);

    if (updateError) {
      logger.error('Error guardando tokens en DB', updateError);
      // Si falla la DB, redirigimos con error pero los tokens se perdieron (seguro)
      return res.redirect(`movi://mp/oauth/error?error=db_error&error_description=${encodeURIComponent('Error guardando la conexión')}`);
    }

    logger.info('OAuth completado y tokens guardados', { userId, mpUserId: mpUser.id });

    // 5. Redirigir a la app con éxito (SIN TOKENS EN URL)
    res.redirect(`movi://mp/oauth/success?mp_user_id=${mpUser.id}`);
  } catch (error: any) {
    logger.error('Error procesando callback de OAuth', error);
    res.redirect(`movi://mp/oauth/error?error=processing_error&error_description=${encodeURIComponent(error.message)}`);
  }
}));

/**
 * GET /mp/oauth/status
 */
router.get('/oauth/status', authMiddleware, asyncHandler(async (req, res) => {
  const user = req.user;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  try {
    const admin = createAdminClient();
    const { data: profile } = await admin
      .from('profiles')
      .select('mp_user_id, mp_status, mp_token_expires_at')
      .eq('id', user.sub)
      .maybeSingle();

    if (!profile) {
      res.status(StatusCodes.NOT_FOUND).json({ error: 'Perfil no encontrado' });
      return;
    }

    const expiresAt = profile.mp_token_expires_at;
    const isExpired = expiresAt ? new Date(expiresAt) < new Date() : false;

    res.status(StatusCodes.OK).json({
      connected: profile.mp_status === 'connected',
      mp_user_id: profile.mp_user_id,
      mp_status: profile.mp_status,
      token_expired: isExpired,
      expires_at: expiresAt,
    });
  } catch (error) {
    logger.error('Error obteniendo estado de MP', error as Error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Error obteniendo estado' });
  }
}));

/**
 * POST /mp/oauth/refresh
 */
router.post('/oauth/refresh', authMiddleware, asyncHandler(async (req, res) => {
  const user = req.user;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  try {
    const admin = createAdminClient();
    const { data: profile } = await admin
      .from('profiles')
      .select('*')
      .eq('id', user.sub)
      .maybeSingle();

    if (!profile?.mp_refresh_token) {
      res.status(StatusCodes.NOT_FOUND).json({ error: 'No se encontró refresh token' });
      return;
    }

    const refreshToken = tokenRepo.decrypt(profile.mp_refresh_token);
    const tokenResponse = await mpService.refreshOAuthToken(refreshToken);

    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + tokenResponse.expires_in);

    await admin
      .from('profiles')
      .update({
        mp_access_token: tokenRepo.encrypt(tokenResponse.access_token),
        mp_refresh_token: tokenRepo.encrypt(tokenResponse.refresh_token),
        mp_token_expires_at: expiresAt.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.sub);

    res.status(StatusCodes.OK).json({ success: true });
  } catch (error) {
    logger.error('Error refrescando token', error as Error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'Error refrescando token' });
  }
}));

export const mercadoPagoOAuthRouter = router;
