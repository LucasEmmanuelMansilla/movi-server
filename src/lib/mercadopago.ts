import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import { env } from '../env';
import { logger } from '../utils/logger';

// Inicializar cliente de Mercado Pago
const accessToken = env.MERCADOPAGO_ACCESS_TOKEN;
if (!accessToken) {
  logger.warn('⚠️ MERCADOPAGO_ACCESS_TOKEN no configurado. Los pagos no funcionarán.');
}

// Detectar si es Sandbox (test token) o Production
// Los tokens de test de Mercado Pago empiezan con "TEST-" o contienen "test"
const isSandbox = accessToken ? (
  accessToken.startsWith('TEST-') || 
  accessToken.toLowerCase().includes('test') ||
  accessToken.includes('sandbox')
) : false;

const client = accessToken ? new MercadoPagoConfig({ accessToken }) : null;
const preference = client ? new Preference(client) : null;
const payment = client ? new Payment(client) : null;

// Porcentaje de comisión de la plataforma (por defecto 10%)
const COMMISSION_PERCENTAGE = parseFloat(env.COMMISSION_PERCENTAGE || '10');

export interface CreatePreferenceParams {
  shipmentId: string;
  title: string;
  amount: number;
  payerEmail: string;
  payerName?: string;
  backUrls?: {
    success?: string;
    failure?: string;
    pending?: string;
  };
}

export interface PaymentSplit {
  driverAmount: number;
  platformCommission: number;
  totalAmount: number;
}

/**
 * Crea una preferencia de pago en Mercado Pago
 */
export async function createPaymentPreference(params: CreatePreferenceParams) {
  if (!preference) {
    throw new Error('Mercado Pago no está configurado. Verifica MERCADOPAGO_ACCESS_TOKEN');
  }

  try {
    // Validar que back_urls.success esté definido y sea una URL válida
    // MercadoPago requiere que back_urls.success exista cuando se usa auto_return
    const hasValidSuccessUrl = params.backUrls?.success && 
                               typeof params.backUrls.success === 'string' && 
                               params.backUrls.success.trim().length > 0;

    const preferenceData: any = {
      items: [
        {
          id: params.shipmentId,
          title: params.title,
          quantity: 1,
          unit_price: params.amount,
          market_place_fee: params.amount * COMMISSION_PERCENTAGE / 100,
        },
      ],
      payer: {
        email: params.payerEmail,
        name: params.payerName,
        // Solo agregar identification en Sandbox (requerido para pruebas)
        ...(isSandbox && {
          identification: {
            type: 'DNI',
            number: '12345678',
          }
        }),
      },
      external_reference: params.shipmentId,
      // Remover statement_descriptor en Sandbox (no permitido)
      ...(!isSandbox && {
        statement_descriptor: 'MOVI ENVIO',
      }),
      binary_mode: true, // Pagos binarios: aprobado o rechazado, sin estados intermedios
      metadata: {
        shipment_id: params.shipmentId,
      },
      notification_url: params.backUrls?.success 
        ? `${params.backUrls.success.replace(/\/success.*$/, '')}/webhook`
        : undefined,
    };

    // Solo incluir back_urls y auto_return si success está definido correctamente
    if (params.backUrls && hasValidSuccessUrl) {
      preferenceData.back_urls = params.backUrls;
      preferenceData.auto_return = 'approved' as const;
      logger.info('Configurando back_urls y auto_return', {
        success: params.backUrls.success,
        hasValidSuccessUrl,
      });
    } else {
      // Si no hay backUrls válidos, no incluir ni back_urls ni auto_return
      logger.warn('back_urls.success no válido, omitiendo back_urls y auto_return', {
        hasBackUrls: !!params.backUrls,
        successUrl: params.backUrls?.success,
        hasValidSuccessUrl,
      });
    }

    logger.debug('Datos de preferencia que se enviarán a MercadoPago', {
      hasBackUrls: !!preferenceData.back_urls,
      hasAutoReturn: !!preferenceData.auto_return,
      external_reference: preferenceData.external_reference,
    });

    const response = await preference.create({ body: preferenceData });

    logger.info('Preferencia de pago creada', {
      preferenceId: response.id,
      shipmentId: params.shipmentId,
      amount: params.amount,
    });

    // Asegurar que tenemos los puntos de inicio correctos
    // En Sandbox: usar sandbox_init_point
    // En Production: usar init_point
    const checkoutUrl = isSandbox 
      ? (response.sandbox_init_point || response.init_point)
      : (response.init_point || response.sandbox_init_point);

    return {
      preferenceId: response.id,
      initPoint: response.init_point || '',
      sandboxInitPoint: response.sandbox_init_point || '',
      checkoutUrl, // URL correcta según el entorno
    };
  } catch (error) {
    logger.error('Error creando preferencia de pago', error as Error, {
      shipmentId: params.shipmentId,
    });
    throw error;
  }
}

/**
 * Obtiene información de un pago por su ID
 */
export async function getPaymentById(paymentId: string) {
  if (!payment) {
    throw new Error('Mercado Pago no está configurado. Verifica MERCADOPAGO_ACCESS_TOKEN');
  }

  try {
    const response = await payment.get({ id: paymentId });
    return response;
  } catch (error) {
    logger.error('Error obteniendo pago', error as Error, { paymentId });
    throw error;
  }
}

/**
 * Busca pagos por external_reference (shipment_id)
 */
export async function findPaymentsByShipmentId(shipmentId: string) {
  if (!payment) {
    throw new Error('Mercado Pago no está configurado. Verifica MERCADOPAGO_ACCESS_TOKEN');
  }

  try {
    // Usar la API de search de Mercado Pago
    const searchParams = {
      external_reference: shipmentId,
    };

    // Nota: El SDK de mercadopago puede no tener un método de búsqueda directo
    // En ese caso, necesitaremos usar la API REST directamente
    // Por ahora, retornamos null y manejaremos la búsqueda en las rutas
    return null;
  } catch (error) {
    logger.error('Error buscando pagos', error as Error, { shipmentId });
    throw error;
  }
}

/**
 * Calcula el split de pagos (comisión y monto para el driver)
 */
export function calculatePaymentSplit(totalAmount: number): PaymentSplit {
  const platformCommission = (totalAmount * COMMISSION_PERCENTAGE) / 100;
  const driverAmount = totalAmount - platformCommission;

  return {
    totalAmount,
    platformCommission: Math.round(platformCommission * 100) / 100,
    driverAmount: Math.round(driverAmount * 100) / 100,
  };
}

/**
 * Verifica si un pago está aprobado
 */
export function isPaymentApproved(paymentStatus: string): boolean {
  return paymentStatus === 'approved';
}

/**
 * Transfiere dinero a un driver usando Advanced Payments de Mercado Pago
 * 
 * ⚠️ IMPORTANTE: Mercado Pago NO tiene un servicio llamado "Connect" para marketplaces.
 * Esta función usa Advanced Payments API, que tiene limitaciones:
 * 
 * LIMITACIONES:
 * - El driver debe tener una cuenta de Mercado Pago activa
 * - Necesitas el user_id de Mercado Pago del driver (no es fácil de obtener solo con email)
 * - NO es un split automático en el momento del pago
 * - Es una transferencia separada que debes hacer después del pago
 * 
 * Para implementar transferencias reales, necesitarías:
 * 1. Driver se registra con su cuenta de Mercado Pago
 * 2. Obtener su user_id de Mercado Pago (requiere proceso manual o API adicional)
 * 3. Almacenar el user_id en la tabla profiles
 * 4. Usar Advanced Payments API para transferir después del pago
 * 
 * ALTERNATIVA RECOMENDADA:
 * - Usar modelo híbrido con transferencias manuales (ver HYBRID_PAYMENT_IMPLEMENTATION.md)
 * - O evaluar Stripe Connect para split automático real
 * 
 * Ejemplo de implementación con Advanced Payments (si tienes el user_id):
 * 
 * const driverMpUserId = await getDriverMercadoPagoUserId(driverId);
 * const advancedPayment = new AdvancedPayment(client);
 * 
 * const transfer = await advancedPayment.create({
 *   body: {
 *     application_id: env.MERCADOPAGO_APPLICATION_ID,
 *     payer: {
 *       id: driverMpUserId, // user_id de Mercado Pago del driver
 *     },
 *     amount: driverAmount,
 *     description: `Pago por entrega de envío ${shipmentId}`,
 *   }
 * });
 */
export async function transferToDriver(
  driverMercadoPagoUserId: string,
  amount: number,
  shipmentId: string
): Promise<{ success: boolean; transferId?: string; error?: string }> {
  // Implementación futura para transferencias reales
  // Por ahora, solo registramos la intención de transferencia
  logger.info('Transferencia de pago programada', {
    driverId: driverMercadoPagoUserId,
    amount,
    shipmentId,
  });

  // TODO: Implementar transferencia real usando Advanced Payments o Marketplace API
  // Esto requerirá:
  // 1. Obtener el access_token del driver desde la base de datos
  // 2. Crear un Advanced Payment o usar la API de transferencias
  // 3. Manejar errores y reintentos

  return {
    success: false,
    error: 'Las transferencias automáticas aún no están implementadas. Mercado Pago no ofrece split automático de pagos. Usa el modelo híbrido con transferencias manuales (ver HYBRID_PAYMENT_IMPLEMENTATION.md) o implementa Advanced Payments si tienes los user_id de los drivers.',
  };
}

/**
 * Intercambia un authorization code por access_token y refresh_token
 * Usa la API de OAuth de Mercado Pago
 */
export interface OAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  user_id: number;
  token_type: string;
}

export async function exchangeOAuthCode(
  authorizationCode: string
): Promise<OAuthTokenResponse> {
  // Usar MP_APPLICATION_ID si está disponible, sino MP_CLIENT_ID
  const clientId = env.MP_APPLICATION_ID || env.MP_CLIENT_ID;
  const clientSecret = env.MP_CLIENT_SECRET;
  const redirectUri = env.MP_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    throw new Error('Configuración de OAuth incompleta. Verifica MP_APPLICATION_ID (o MP_CLIENT_ID) y MP_REDIRECT_URI');
  }

  if (!clientSecret) {
    throw new Error('MP_CLIENT_SECRET es requerido para el intercambio de tokens OAuth. Este valor corresponde a la SECRET_KEY de tu aplicación de Mercado Pago, disponible en "Detalles de la aplicación > Credenciales". Si no la ves, verifica que tu aplicación esté configurada con el modelo de integración "Marketplace" (debe aparecer después de seleccionar el producto Checkout Pro o Checkout API).');
  }

  try {
    // URL base según el entorno (sandbox o producción)
    const baseUrl = isSandbox 
      ? 'https://api.mercadopago.com' // En sandbox también se usa api.mercadopago.com
      : 'https://api.mercadopago.com';

    const response = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code: authorizationCode,
        redirect_uri: redirectUri,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Error intercambiando código OAuth', new Error(errorText), {
        status: response.status,
        statusText: response.statusText,
      });
      throw new Error(`Error en OAuth: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as OAuthTokenResponse;
    
    logger.info('Código OAuth intercambiado exitosamente', {
      user_id: data.user_id,
      expires_in: data.expires_in,
    });

    return data;
  } catch (error) {
    logger.error('Error intercambiando código OAuth', error as Error);
    throw error;
  }
}

/**
 * Refresca un access_token usando el refresh_token
 */
export async function refreshOAuthToken(
  refreshToken: string
): Promise<OAuthTokenResponse> {
  // Usar MP_APPLICATION_ID si está disponible, sino MP_CLIENT_ID
  const clientId = env.MP_APPLICATION_ID || env.MP_CLIENT_ID;
  const clientSecret = env.MP_CLIENT_SECRET;

  if (!clientId) {
    throw new Error('Configuración de OAuth incompleta. Verifica MP_APPLICATION_ID (o MP_CLIENT_ID)');
  }

  if (!clientSecret) {
    throw new Error('MP_CLIENT_SECRET es requerido para refrescar tokens OAuth. Este valor corresponde a la SECRET_KEY de tu aplicación de Mercado Pago, disponible en "Detalles de la aplicación > Credenciales". Si no la ves, verifica que tu aplicación esté configurada con el modelo de integración "Marketplace".');
  }

  try {
    const baseUrl = isSandbox 
      ? 'https://api.mercadopago.com'
      : 'https://api.mercadopago.com';

    const response = await fetch(`${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Error refrescando token OAuth', new Error(errorText), {
        status: response.status,
        statusText: response.statusText,
      });
      throw new Error(`Error refrescando token: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as OAuthTokenResponse;
    
    logger.info('Token OAuth refrescado exitosamente', {
      user_id: data.user_id,
      expires_in: data.expires_in,
    });

    return data;
  } catch (error) {
    logger.error('Error refrescando token OAuth', error as Error);
    throw error;
  }
}

/**
 * Obtiene información del usuario autenticado
 * Usa el endpoint GET /users/me de Mercado Pago
 */
export interface MercadoPagoUser {
  id: number;
  nickname: string;
  first_name: string;
  last_name: string;
  email: string;
  site_id: string;
  country_id: string;
  permalink: string;
  registration_date: string;
  status: {
    site_status: string;
  };
}

export async function getMercadoPagoUser(
  accessToken: string
): Promise<MercadoPagoUser> {
  try {
    const baseUrl = isSandbox 
      ? 'https://api.mercadopago.com'
      : 'https://api.mercadopago.com';

    const response = await fetch(`${baseUrl}/users/me`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Error obteniendo usuario de Mercado Pago', new Error(errorText), {
        status: response.status,
        statusText: response.statusText,
      });
      throw new Error(`Error obteniendo usuario: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as MercadoPagoUser;
    
    logger.info('Usuario de Mercado Pago obtenido', {
      user_id: data.id,
      email: data.email,
    });

    return data;
  } catch (error) {
    logger.error('Error obteniendo usuario de Mercado Pago', error as Error);
    throw error;
  }
}

/**
 * IMPORTANTE: Mercado Pago NO permite transferencias directas entre cuentas de esta manera.
 * 
 * SOLUCIÓN IMPLEMENTADA:
 * En lugar de transferir automáticamente, registramos la transferencia como "pendiente"
 * en la tabla driver_transfers. El marketplace debe procesar estas transferencias de una de estas formas:
 * 
 * 1. RETIRO MANUAL: El driver retira el dinero desde su panel de Mercado Pago
 * 2. TRANSFERENCIA BANCARIA: El marketplace transfiere a la cuenta bancaria del driver
 * 3. SPLIT DE PAGOS: Implementar split desde el inicio (requiere saber el driver antes del pago)
 * 
 * FLUJO ACTUAL:
 * 1. Business paga → dinero queda en cuenta del marketplace
 * 2. Driver marca entregado → se registra transferencia como "pending"
 * 3. Marketplace procesa manualmente o driver retira fondos
 * 4. Se marca la transferencia como "completed"
 * 
 * Esta función ahora solo REGISTRA la intención de transferencia.
 */
export interface TransferParams {
  amount: number;
  driverUserId: number; // mp_user_id del driver (destinatario de la transferencia)
  description: string;
  externalReference?: string; // ID del pago o envío relacionado
}

export interface TransferResponse {
  id: number;
  amount: number;
  status: string;
  date_created: string;
  description: string;
  external_reference?: string;
  destination_user_id?: number;
}

export async function transferToUser(
  params: TransferParams
): Promise<TransferResponse> {
  if (!params.driverUserId) {
    throw new Error('driverUserId es requerido para realizar la transferencia');
  }

  // NOTA: Mercado Pago NO permite transferencias automáticas de esta forma
  // Esta función ahora solo registra la intención de transferencia
  // La transferencia real debe hacerse manualmente o mediante retiro del driver
  
  logger.info('Registrando transferencia pendiente (no automática)', {
    driverUserId: params.driverUserId,
    amount: params.amount,
    description: params.description,
    externalReference: params.externalReference,
  });

  // Retornar una respuesta simulada indicando que la transferencia está pendiente
  const transferResponse: TransferResponse = {
    id: Date.now(), // ID temporal basado en timestamp
    amount: params.amount,
    status: 'pending', // Siempre pendiente - requiere procesamiento manual
    date_created: new Date().toISOString(),
    description: params.description,
    external_reference: params.externalReference,
    destination_user_id: params.driverUserId,
  };
  
  logger.warn('Transferencia registrada como PENDIENTE - requiere procesamiento manual', {
    transferId: transferResponse.id,
    amount: transferResponse.amount,
    driverUserId: params.driverUserId,
    note: 'El marketplace debe procesar esta transferencia manualmente o el driver debe retirar los fondos',
  });

  return transferResponse;
}

export { COMMISSION_PERCENTAGE };

