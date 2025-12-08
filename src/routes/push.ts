import { Router } from 'express';
import fetch from 'node-fetch';
import jwt from 'jsonwebtoken';
import { createAdminClient } from '../lib/supabase';
import { StatusCodes } from 'http-status-codes';
import asyncHandler from 'express-async-handler';

const router = Router();

// Registrar o actualizar token de push para el usuario autenticado
router.post('/register', asyncHandler(async (req, res) => {
  const user = req.user as { sub: string } | undefined;
  if (!user?.sub) {
    console.log('[Push Register] Usuario no autenticado');
    return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Unauthorized' });
  }

  const { token, platform: rawPlatform } = req.body as { token?: string; platform?: string };
  
  if (!token) {
    console.log('[Push Register] Token no proporcionado');
    return res.status(StatusCodes.BAD_REQUEST).json({ 
      error: 'Token is required' 
    });
  }

  // Normalizar platform: solo aceptar 'android', 'ios', o null
  let platform: string | null = null;
  if (rawPlatform) {
    const normalized = rawPlatform.toLowerCase();
    if (normalized === 'android' || normalized.includes('android')) {
      platform = 'android';
    } else if (normalized === 'ios' || normalized.includes('ios')) {
      platform = 'ios';
    }
    // Si no es android ni ios, dejamos platform como null
  }

  console.log('[Push Register] Registrando token para usuario:', { 
    userId: user.sub, 
    platform,
    rawPlatform,
    tokenPrefix: token.substring(0, 20) + '...'
  });

  const admin = createAdminClient();
  
  try {
    // Primero verificar si ya existe un token para este usuario
    const { data: existing, error: checkError } = await admin
      .from('push_tokens')
      .select('id, token')
      .eq('user_id', user.sub)
      .eq('token', token)
      .maybeSingle();

    if (checkError) {
      console.error('[Push Register] Error al verificar token existente:', checkError);
      throw checkError;
    }

    let data;
    if (existing) {
      // Actualizar si ya existe (solo platform, no created_at)
      const { data: updated, error: updateError } = await admin
        .from('push_tokens')
        .update({ 
          platform: platform || null
        })
        .eq('id', existing.id)
        .select();
      
      if (updateError) {
        console.error('[Push Register] Error al actualizar token:', updateError);
        throw updateError;
      }
      data = updated;
    } else {
      // Insertar nuevo token
      const { data: inserted, error: insertError } = await admin
        .from('push_tokens')
        .insert({ 
          user_id: user.sub, 
          token, 
          platform: platform || null 
        })
        .select();
      
      if (insertError) {
        console.error('[Push Register] Error al insertar token:', insertError);
        throw insertError;
      }
      data = inserted;
    }
    
    console.log('[Push Register] Token registrado exitosamente:', { 
      userId: user.sub,
      tokenId: data?.[0]?.id 
    });
    
    res.status(StatusCodes.NO_CONTENT).send();
  } catch (error) {
    console.error('[Push Register] Error al registrar token:', error);
    res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ 
      error: 'Failed to register push token',
      details: error instanceof Error ? error.message : String(error)
    });
  }
}));

// Obtener token de acceso OAuth2 para FCM v1 API
async function getAccessToken(serviceAccountKey: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccountKey.client_email,
    sub: serviceAccountKey.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600, // 1 hora
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
  };

  const token = jwt.sign(payload, serviceAccountKey.private_key, {
    algorithm: 'RS256',
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: token,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Error obteniendo access token: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  return result.access_token;
}

// Utilidad para enviar notificaciones via FCM v1 API (Firebase Cloud Messaging)
export async function sendPush(tokens: string[], title: string, body: string, data?: Record<string, any>) {
  if (!tokens.length) {
    console.log('[Push] No hay tokens para enviar notificaciones');
    return;
  }

  // Intentar usar API v1 primero (recomendada)
  const projectId = process.env.FCM_PROJECT_ID || 'movi-aead6'; // Del google-services.json
  const serviceAccountKeyStr = process.env.FCM_SERVICE_ACCOUNT_KEY;
  
  if (serviceAccountKeyStr) {
    try {
      const serviceAccountKey = JSON.parse(serviceAccountKeyStr);
      const accessToken = await getAccessToken(serviceAccountKey);
      
      console.log(`[Push] Enviando ${tokens.length} notificación(es) via FCM v1 API`, { 
        title,
        tokenCount: tokens.length 
      });

      const admin = createAdminClient();
      const invalidTokens: string[] = [];

      const results = await Promise.allSettled(
        tokens.map(async (token) => {
          const message = {
            message: {
              token: token,
              notification: {
                title,
                body,
              },
              data: data ? Object.fromEntries(
                Object.entries(data).map(([k, v]) => [k, String(v)])
              ) : {},
              android: {
                priority: 'high',
                notification: {
                  channelId: 'default',
                  sound: 'default',
                },
              },
              apns: {
                payload: {
                  aps: {
                    sound: 'default',
                    badge: 1,
                  },
                },
              },
            },
          };

          const response = await fetch(
            `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
              },
              body: JSON.stringify(message),
            }
          );

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = errorData?.error?.message || await response.text();
            
            // Detectar tokens inválidos
            if (
              response.status === 400 && 
              (errorMessage.includes('INVALID_ARGUMENT') || 
               errorMessage.includes('registration token is not a valid') ||
               errorMessage.includes('not a valid FCM registration token'))
            ) {
              invalidTokens.push(token);
              throw new Error(`Token inválido: ${token.substring(0, 20)}...`);
            }
            
            throw new Error(`FCM v1 error: ${response.status} - ${errorMessage}`);
          }

          const result = await response.json();
          return { token, success: true, messageId: result.name };
        })
      );

      // Eliminar tokens inválidos de la base de datos
      if (invalidTokens.length > 0) {
        console.warn(`[Push] Eliminando ${invalidTokens.length} token(s) inválido(s) de la base de datos`);
        try {
          const { error: deleteError } = await admin
            .from('push_tokens')
            .delete()
            .in('token', invalidTokens);
          
          if (deleteError) {
            console.error('[Push] Error al eliminar tokens inválidos:', deleteError);
          } else {
            console.log(`[Push] ${invalidTokens.length} token(s) inválido(s) eliminado(s) exitosamente`);
          }
        } catch (deleteErr) {
          console.error('[Push] Error al eliminar tokens inválidos:', deleteErr);
        }
      }

      // Analizar resultados
      const successful = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;

      if (failed > 0) {
        const errors = results
          .filter(r => r.status === 'rejected')
          .map(r => {
            const reason = (r as PromiseRejectedResult).reason;
            // Mostrar solo el mensaje, no el stack trace completo
            return reason instanceof Error ? reason.message : String(reason);
          });
        
        // Filtrar errores de tokens inválidos (ya los manejamos arriba)
        const otherErrors = errors.filter(e => !e.includes('Token inválido'));
        
        if (otherErrors.length > 0) {
          console.error('[Push] Algunas notificaciones fallaron:', otherErrors);
        }
        
        if (invalidTokens.length > 0) {
          console.warn(`[Push] ${invalidTokens.length} token(s) inválido(s) detectado(s) y eliminado(s)`);
        }
      }

      if (successful > 0) {
        console.log(`[Push] ${successful} notificación(es) enviada(s) exitosamente via FCM v1`);
      }

      if (successful === 0 && invalidTokens.length === 0) {
        console.error('[Push] Todas las notificaciones fallaron');
      }

      return;
    } catch (error) {
      console.error('[Push] Error con FCM v1 API, intentando legacy...', error);
      // Continuar con legacy API como fallback
    }
  }

  // Fallback a API legacy (si está configurada)
  const fcmServerKey = process.env.FCM_SERVER_KEY;
  if (!fcmServerKey) {
    console.error('[Push] ❌ FCM no está configurado correctamente');
    console.error('[Push] 💡 Para configurar FCM v1 (recomendado):');
    console.error('[Push]    1. Ve a Firebase Console → Tu proyecto → Configuración → Cuentas de servicio');
    console.error('[Push]    2. Haz clic en "Generar nueva clave privada"');
    console.error('[Push]    3. Descarga el archivo JSON');
    console.error('[Push]    4. Agrega FCM_SERVICE_ACCOUNT_KEY=\'{"type":"service_account",...}\' en el archivo .env');
    console.error('[Push]    5. Agrega FCM_PROJECT_ID=tu_project_id en el archivo .env');
    console.error('[Push]    6. Reinicia el servidor');
    console.error('[Push] 💡 Alternativa (legacy - deprecated):');
    console.error('[Push]    Habilita la API legacy en Firebase Console y usa FCM_SERVER_KEY');
    return;
  }

  try {
    console.log(`[Push] Enviando ${tokens.length} notificación(es) via FCM`, { 
      title,
      tokenCount: tokens.length 
    });

    // FCM permite enviar a múltiples tokens en una sola petición (hasta 500)
    // Pero es más confiable enviar individualmente para mejor manejo de errores
    const results = await Promise.allSettled(
      tokens.map(async (token) => {
        const message = {
          to: token,
          notification: {
            title,
            body,
            sound: 'default',
          },
          data: data || {},
          android: {
            priority: 'high',
            notification: {
              channelId: 'default',
              sound: 'default',
            },
          },
          apns: {
            payload: {
              aps: {
                sound: 'default',
                badge: 1,
              },
            },
          },
        };

        const response = await fetch('https://fcm.googleapis.com/fcm/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `key=${fcmServerKey}`,
          },
          body: JSON.stringify(message),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`FCM error: ${response.status} - ${errorText}`);
        }

        const result = await response.json();
        
        // FCM retorna success: 1 si fue exitoso, 0 si falló
        if (result.success === 0) {
          throw new Error(`FCM error: ${result.results?.[0]?.error || 'Unknown error'}`);
        }

        return { token, success: true, messageId: result.results?.[0]?.message_id };
      })
    );

    // Analizar resultados
    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    if (failed > 0) {
      const errors = results
        .filter(r => r.status === 'rejected')
        .map(r => (r as PromiseRejectedResult).reason);
      console.error('[Push] Algunas notificaciones fallaron:', errors);
    }

    if (successful > 0) {
      console.log(`[Push] ${successful} notificación(es) enviada(s) exitosamente`);
    }

    // Si todos fallaron, loguear pero no lanzar error
    if (successful === 0) {
      console.error('[Push] Todas las notificaciones fallaron');
    }
  } catch (error) {
    console.error('[Push] Error al enviar notificaciones:', error);
    // No lanzamos el error para no romper el flujo principal
  }
}

export const pushRouter = router;
