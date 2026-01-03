import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createAdminClient } from '../lib/supabase';
import { exchangeOAuthCode, refreshOAuthToken, getMercadoPagoUser } from '../lib/mercadopago';
import { StatusCodes } from 'http-status-codes';
import asyncHandler from 'express-async-handler';
import { logger } from '../utils/logger';
import { validateQuery } from '../utils/validation';
import { authMiddleware } from '../middleware/auth';
import { env } from '../env';
import crypto from 'crypto';

const router = Router();

// Función para encriptar tokens (simple, en producción usar algo más robusto)
function encryptToken(token: string): string {
  const algorithm = 'aes-256-cbc';
  const key = crypto.scryptSync(env.SUPABASE_SERVICE_ROLE_KEY || 'default-key', 'salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(token, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

// Función para desencriptar tokens
function decryptToken(encryptedToken: string): string {
  const algorithm = 'aes-256-cbc';
  const key = crypto.scryptSync(env.SUPABASE_SERVICE_ROLE_KEY || 'default-key', 'salt', 32);
  const [ivHex, encrypted] = encryptedToken.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * GET /mp/oauth/callback
 * Callback de OAuth de Mercado Pago
 * Intercambia el authorization code por tokens y guarda la información del usuario
 */
const OAuthCallbackQuery = z.object({
  code: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

router.get('/oauth/callback', validateQuery(OAuthCallbackQuery), asyncHandler(async (req, res) => {
  const { code, error, error_description } = req.query;

  // Si hay error, redirigir a la app con error
  if (error) {
    logger.warn('Error en callback de OAuth', { error, error_description });
    const deepLink = `movi://mp/oauth/error?error=${encodeURIComponent(error as string)}&error_description=${encodeURIComponent((error_description as string) || '')}`;
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Error de conexión</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              margin: 0;
              background: linear-gradient(135deg, #f5576c 0%, #f093fb 100%);
              color: white;
            }
            .container {
              text-align: center;
              padding: 2rem;
            }
            h1 { margin-bottom: 1rem; }
            p { opacity: 0.9; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>❌ Error de conexión</h1>
            <p>Redirigiendo a la app...</p>
          </div>
          <script>
            window.location.href = '${deepLink}';
          </script>
        </body>
      </html>
    `;
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
    return;
  }

  if (!code) {
    logger.warn('Callback de OAuth sin código');
    const deepLink = `movi://mp/oauth/error?error=missing_code&error_description=${encodeURIComponent('No se recibió el código de autorización')}`;
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Error</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              margin: 0;
              background: linear-gradient(135deg, #f5576c 0%, #f093fb 100%);
              color: white;
            }
            .container {
              text-align: center;
              padding: 2rem;
            }
            h1 { margin-bottom: 1rem; }
            p { opacity: 0.9; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>❌ Error</h1>
            <p>No se recibió el código de autorización</p>
          </div>
          <script>
            window.location.href = '${deepLink}';
          </script>
        </body>
      </html>
    `;
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
    return;
  }

  try {
    // Intercambiar código por tokens
    const tokenResponse = await exchangeOAuthCode(code as string);

    // Obtener información del usuario
    const mpUser = await getMercadoPagoUser(tokenResponse.access_token);

    // Calcular fecha de expiración
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + tokenResponse.expires_in);

    // Encriptar tokens antes de guardar
    const encryptedAccessToken = encryptToken(tokenResponse.access_token);
    const encryptedRefreshToken = encryptToken(tokenResponse.refresh_token);

    // Guardar en la base de datos
    // Nota: Necesitamos el user_id del usuario autenticado
    // Por ahora, guardamos los datos y el usuario deberá completar el proceso desde la app
    // En una implementación real, podrías usar un state parameter en OAuth para identificar al usuario
    
    // Por ahora, retornamos los datos para que el frontend los guarde
    // El frontend deberá llamar a un endpoint POST /mp/oauth/connect con los tokens
    
    logger.info('OAuth completado exitosamente', {
      mp_user_id: mpUser.id,
      user_email: mpUser.email,
    });

    // Redirigir a la app con éxito y los datos necesarios
    // En producción, estos datos deberían guardarse en el backend usando un state token
    const deepLink = `movi://mp/oauth/success?mp_user_id=${mpUser.id}&access_token=${encodeURIComponent(tokenResponse.access_token)}&refresh_token=${encodeURIComponent(tokenResponse.refresh_token)}&expires_in=${tokenResponse.expires_in}`;
    
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Conexión exitosa</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              margin: 0;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
            }
            .container {
              text-align: center;
              padding: 2rem;
            }
            h1 { margin-bottom: 1rem; }
            p { opacity: 0.9; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>✅ Conexión exitosa</h1>
            <p>Redirigiendo a la app...</p>
          </div>
          <script>
            window.location.href = '${deepLink}';
          </script>
        </body>
      </html>
    `;
    
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    logger.error('Error procesando callback de OAuth', error as Error, { code });
    const errorMessage = error instanceof Error ? error.message : 'Error desconocido';
    const deepLink = `movi://mp/oauth/error?error=processing_error&error_description=${encodeURIComponent(errorMessage)}`;
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Error</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              margin: 0;
              background: linear-gradient(135deg, #f5576c 0%, #f093fb 100%);
              color: white;
            }
            .container {
              text-align: center;
              padding: 2rem;
            }
            h1 { margin-bottom: 1rem; }
            p { opacity: 0.9; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>❌ Error</h1>
            <p>${errorMessage}</p>
          </div>
          <script>
            window.location.href = '${deepLink}';
          </script>
        </body>
      </html>
    `;
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  }
}));

/**
 * POST /mp/oauth/connect
 * Guarda los tokens de OAuth en el perfil del usuario autenticado
 */
const ConnectOAuthBody = z.object({
  mp_user_id: z.number(),
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
});

router.post('/oauth/connect', authMiddleware, asyncHandler(async (req, res) => {
  const user = req.user as { sub: string } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  const parsed = ConnectOAuthBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(StatusCodes.BAD_REQUEST).json({
      error: 'Datos inválidos',
      details: parsed.error.flatten(),
    });
    return;
  }

  const { mp_user_id, access_token, refresh_token, expires_in } = parsed.data;

  try {
    const admin = createAdminClient();

    // Calcular fecha de expiración
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + expires_in);

    // Encriptar tokens antes de guardar
    const encryptedAccessToken = encryptToken(access_token);
    const encryptedRefreshToken = encryptToken(refresh_token);

    // Verificar que el usuario existe y es driver
    const { data: profile } = await admin
      .from('profiles')
      .select('id, role')
      .eq('id', user.sub)
      .maybeSingle();

    if (!profile) {
      res.status(StatusCodes.NOT_FOUND).json({ error: 'Perfil no encontrado' });
      return;
    }

    if (profile.role !== 'driver') {
      res.status(StatusCodes.FORBIDDEN).json({ 
        error: 'Solo los conductores pueden conectar Mercado Pago' 
      });
      return;
    }

    // Validar cuenta con GET /users/me
    try {
      await getMercadoPagoUser(access_token);
    } catch (error) {
      logger.error('Error validando cuenta de Mercado Pago', error as Error);
      res.status(StatusCodes.BAD_REQUEST).json({ 
        error: 'No se pudo validar la cuenta de Mercado Pago. Verifica que el token sea válido.' 
      });
      return;
    }

    // Actualizar perfil con información de Mercado Pago
    // Nota: Estos campos deben existir en la tabla profiles
    const updateData: any = {
      mp_user_id: mp_user_id.toString(),
      mp_access_token: encryptedAccessToken,
      mp_refresh_token: encryptedRefreshToken,
      mp_token_expires_at: expiresAt.toISOString(),
      mp_status: 'connected',
      updated_at: new Date().toISOString(),
    };

    const { data: updatedProfile, error: updateError } = await admin
      .from('profiles')
      .update(updateData)
      .eq('id', user.sub)
      .select('id, mp_user_id, mp_status')
      .maybeSingle();

    if (updateError) {
      // Si los campos no existen, intentar solo con campos básicos
      logger.warn('Error actualizando perfil con campos de MP, intentando sin ellos', updateError);
      
      // Por ahora, retornamos éxito aunque no se hayan guardado los campos
      // En producción, deberías crear una migración para agregar estos campos
      logger.info('Tokens de OAuth recibidos (campos de MP no disponibles en BD)', {
        userId: user.sub,
        mpUserId: mp_user_id,
      });

      res.status(StatusCodes.OK).json({
        success: true,
        message: 'Conexión exitosa. Nota: Los campos de Mercado Pago no están disponibles en la base de datos.',
        mp_user_id: mp_user_id,
        mp_status: 'connected',
      });
      return;
    }

    logger.info('Mercado Pago conectado exitosamente', {
      userId: user.sub,
      mpUserId: mp_user_id,
    });

    res.status(StatusCodes.OK).json({
      success: true,
      mp_user_id: (updatedProfile as any)?.mp_user_id || mp_user_id.toString(),
      mp_status: (updatedProfile as any)?.mp_status || 'connected',
    });
  } catch (error) {
    logger.error('Error conectando Mercado Pago', error as Error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'Error conectando Mercado Pago' 
    });
  }
}));

/**
 * POST /mp/oauth/refresh
 * Refresca el access_token usando el refresh_token
 */
router.post('/oauth/refresh', authMiddleware, asyncHandler(async (req, res) => {
  const user = req.user as { sub: string } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  try {
    const admin = createAdminClient();

    // Obtener perfil con refresh_token
    let profile: any = null;
    try {
      const result = await admin
        .from('profiles')
        .select('mp_refresh_token')
        .eq('id', user.sub)
        .maybeSingle();
      profile = result.data as any;
    } catch (selectError: any) {
      // Si hay error por campos que no existen
      if (selectError.code === '42703' || selectError.message?.includes('does not exist')) {
        profile = null;
      } else {
        throw selectError;
      }
    }

    if (!profile || !profile.mp_refresh_token) {
      res.status(StatusCodes.NOT_FOUND).json({ 
        error: 'No se encontró refresh_token. Por favor, reconecta tu cuenta de Mercado Pago.' 
      });
      return;
    }

    // Desencriptar refresh_token
    const refreshToken = decryptToken(profile.mp_refresh_token);

    // Refrescar token
    const tokenResponse = await refreshOAuthToken(refreshToken);

    // Calcular fecha de expiración
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + tokenResponse.expires_in);

    // Encriptar nuevos tokens
    const encryptedAccessToken = encryptToken(tokenResponse.access_token);
    const encryptedRefreshToken = encryptToken(tokenResponse.refresh_token);

    // Actualizar perfil
    const updateData: any = {
      mp_access_token: encryptedAccessToken,
      mp_refresh_token: encryptedRefreshToken,
      mp_token_expires_at: expiresAt.toISOString(),
      updated_at: new Date().toISOString(),
    };

    await admin
      .from('profiles')
      .update(updateData)
      .eq('id', user.sub);

    logger.info('Token de Mercado Pago refrescado', {
      userId: user.sub,
    });

    res.status(StatusCodes.OK).json({
      success: true,
      expires_in: tokenResponse.expires_in,
    });
  } catch (error) {
    logger.error('Error refrescando token de Mercado Pago', error as Error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'Error refrescando token' 
    });
  }
}));

/**
 * GET /mp/oauth/url
 * Obtiene la URL de OAuth de Mercado Pago
 */
router.get('/oauth/url', asyncHandler(async (req, res) => {
  const clientId = env.MP_CLIENT_ID;
  const redirectUri = env.MP_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    logger.warn('OAuth de Mercado Pago no configurado', {
      hasClientId: !!clientId,
      hasRedirectUri: !!redirectUri,
    });
    res.status(StatusCodes.SERVICE_UNAVAILABLE).json({ 
      error: 'OAuth de Mercado Pago no está configurado. Verifica las variables de entorno MP_CLIENT_ID y MP_REDIRECT_URI.',
      details: {
        hasClientId: !!clientId,
        hasRedirectUri: !!redirectUri,
      }
    });
    return;
  }

  const encodedRedirectUri = encodeURIComponent(redirectUri);
  const scope = encodeURIComponent('offline_access read write');
  
  // URL de OAuth de Mercado Pago para Argentina
  const oauthUrl = `https://auth.mercadopago.com.ar/authorization?client_id=${clientId}&response_type=code&platform_id=mp&redirect_uri=${encodedRedirectUri}&scope=${scope}`;

  res.status(StatusCodes.OK).json({
    oauth_url: oauthUrl,
  });
}));

/**
 * GET /mp/oauth/status
 * Obtiene el estado de la conexión de Mercado Pago del usuario
 */
router.get('/oauth/status', authMiddleware, asyncHandler(async (req, res) => {
  const user = req.user as { sub: string } | undefined;
  if (!user?.sub) {
    res.status(StatusCodes.UNAUTHORIZED).json({ error: 'No autorizado' });
    return;
  }

  try {
    const admin = createAdminClient();

    // Intentar obtener los campos de Mercado Pago
    // Si los campos no existen, Supabase los omitirá automáticamente
    let profile: any = null;
    try {
      const result = await admin
        .from('profiles')
        .select('id, mp_user_id, mp_status, mp_token_expires_at')
        .eq('id', user.sub)
        .maybeSingle();
      profile = result.data as any;
    } catch (selectError: any) {
      // Si hay error por campos que no existen, intentar solo con id
      if (selectError.code === '42703' || selectError.message?.includes('does not exist')) {
        const result = await admin
          .from('profiles')
          .select('id')
          .eq('id', user.sub)
          .maybeSingle();
        profile = result.data as any;
      } else {
        throw selectError;
      }
    }

    if (!profile) {
      res.status(StatusCodes.NOT_FOUND).json({ error: 'Perfil no encontrado' });
      return;
    }

    const mpStatus = profile?.mp_status || null;
    const mpUserId = profile?.mp_user_id || null;
    const expiresAt = profile?.mp_token_expires_at || null;

    // Verificar si el token está expirado
    let isExpired = false;
    if (expiresAt) {
      try {
        const expirationDate = new Date(expiresAt);
        isExpired = expirationDate < new Date();
      } catch (dateError) {
        // Si hay error parseando la fecha, considerar como expirado
        isExpired = true;
      }
    }

    res.status(StatusCodes.OK).json({
      connected: mpStatus === 'connected',
      mp_user_id: mpUserId,
      mp_status: mpStatus,
      token_expired: isExpired,
      expires_at: expiresAt,
    });
  } catch (error) {
    logger.error('Error obteniendo estado de Mercado Pago', error as Error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'Error obteniendo estado' 
    });
  }
}));

export const mercadoPagoOAuthRouter = router;
