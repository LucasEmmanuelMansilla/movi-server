import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import { env } from '../env';
import { logger } from '../utils/logger';

export interface CreatePreferenceParams {
  shipmentId: string;
  title: string;
  amount: number;
  payerEmail: string;
  payerName?: string;
  payerIdentification?: {
    type: string;
    number: string;
  };
  backUrls?: {
    success?: string;
    failure?: string;
    pending?: string;
  };
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  user_id: number;
  token_type: string;
}

export interface MercadoPagoUser {
  id: number;
  email: string;
  nickname: string;
}

export class MercadoPagoService {
  private static instance: MercadoPagoService;
  private client: MercadoPagoConfig | null = null;
  private preferenceClient: Preference | null = null;
  private paymentClient: Payment | null = null;
  private isSandbox: boolean = false;
  private readonly baseUrl = 'https://api.mercadopago.com';

  private constructor() {
    const accessToken = env.MERCADOPAGO_ACCESS_TOKEN;
    if (!accessToken) {
      logger.warn('⚠️ MERCADOPAGO_ACCESS_TOKEN no configurado.');
      return;
    }

    this.isSandbox = accessToken.startsWith('TEST-') || 
                     accessToken.toLowerCase().includes('test') ||
                     accessToken.includes('sandbox');

    this.client = new MercadoPagoConfig({ accessToken });
    this.preferenceClient = new Preference(this.client);
    this.paymentClient = new Payment(this.client);
  }

  public static getInstance(): MercadoPagoService {
    if (!MercadoPagoService.instance) {
      MercadoPagoService.instance = new MercadoPagoService();
    }
    return MercadoPagoService.instance;
  }

  /**
   */
  public async createPaymentPreference(params: CreatePreferenceParams) {
    if (!this.preferenceClient) {
      throw new Error('Mercado Pago no está configurado');
    }

    const preferenceData: any = {
      items: [
        {
          id: params.shipmentId,
          title: params.title,
          quantity: 1,
          unit_price: Number(params.amount),
          currency_id: 'ARS',
        },
      ],
      payer: {
        email: params.payerEmail,
        ...(params.payerName ? { 
          name: params.payerName,
          first_name: params.payerName.split(' ')[0],
          last_name: params.payerName.split(' ').slice(1).join(' ') || 'User'
        } : (this.isSandbox ? {
          name: 'Test User',
          first_name: 'Test',
          last_name: 'User'
        } : {})),
        ...(params.payerIdentification ? { identification: params.payerIdentification } : 
           (this.isSandbox ? { identification: { type: 'DNI', number: '12345678' } } : {})),
        ...(this.isSandbox ? {
          address: {
            zip_code: '1000',
            street_name: 'Calle Falsa',
            street_number: 123
          }
        } : {})
      },
      external_reference: params.shipmentId,
      binary_mode: true, // Forzar respuesta inmediata (aprobado o rechazado)
      metadata: {
        shipment_id: params.shipmentId,
      },
      ...(!this.isSandbox && {
        statement_descriptor: 'MOVI ENVIO',
      }),
      back_urls: params.backUrls,
      auto_return: params.backUrls?.success ? 'approved' : undefined,
      notification_url: params.backUrls?.success 
        ? `${env.API_URL.replace(/\/$/, '')}/payments/webhook`
        : undefined,
      payment_methods: {
        excluded_payment_types: [
          { id: 'ticket' }
        ],
        installments: 1,
      }
    };

    logger.info('Creando preferencia de Mercado Pago', { 
      shipmentId: params.shipmentId, 
      isSandbox: this.isSandbox,
      notificationUrl: preferenceData.notification_url 
    });

    const response = await this.preferenceClient.create({ body: preferenceData });

    const checkoutUrl = this.isSandbox 
      ? (response.sandbox_init_point || response.init_point)
      : (response.init_point || response.sandbox_init_point);

    return {
      preferenceId: response.id,
      initPoint: response.init_point,
      sandboxInitPoint: response.sandbox_init_point,
      checkoutUrl,
    };
  }

  /**
   */
  public async exchangeOAuthCode(authorizationCode: string): Promise<OAuthTokenResponse> {
    const clientId = env.MP_APPLICATION_ID || env.MP_CLIENT_ID;
    const clientSecret = env.MP_CLIENT_SECRET;
    const redirectUri = env.MP_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
      throw new Error('Configuración de OAuth incompleta');
    }

    const response = await fetch(`${this.baseUrl}/oauth/token`, {
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
      throw new Error(`Error en OAuth MP: ${response.status} - ${errorText}`);
    }

    return await response.json() as OAuthTokenResponse;
  }

  /**
   */
  public async refreshOAuthToken(refreshToken: string): Promise<OAuthTokenResponse> {
    const clientId = env.MP_APPLICATION_ID || env.MP_CLIENT_ID;
    const clientSecret = env.MP_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error('Configuración de OAuth incompleta');
    }

    const response = await fetch(`${this.baseUrl}/oauth/token`, {
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
      throw new Error(`Error refreshing MP token: ${response.status} - ${errorText}`);
    }

    return await response.json() as OAuthTokenResponse;
  }

  /**
   * Crea una transferencia de dinero desde la cuenta principal a CBU/CVU/Alias del destinatario.
   * Requiere que el Access Token tenga permisos de transferencia (cuenta vendedor con fondos).
   */
  public async createMoneyTransfer(params: {
    amount: number;
    currencyId: 'ARS';
    description: string;
    recipient: {
      cbu?: string;
      cvu?: string;
      alias?: string;
      accountHolderName: string;
    };
  }): Promise<{ id: string; status: string }> {
    const accessToken = env.MERCADOPAGO_ACCESS_TOKEN;
    if (!accessToken) {
      throw new Error('Mercado Pago no está configurado (MERCADOPAGO_ACCESS_TOKEN)');
    }

    const { cbu, cvu, alias, accountHolderName } = params.recipient;
    if (!cbu && !cvu && !alias) {
      throw new Error('Se debe proporcionar CBU, CVU o Alias del destinatario');
    }
    if (!accountHolderName?.trim()) {
      throw new Error('Se debe proporcionar el nombre del titular de la cuenta');
    }

    const body: Record<string, unknown> = {
      amount: Number(params.amount),
      currency_id: params.currencyId,
      description: params.description,
      destination: {
        entity_type: 'bank_account',
        identification: {
          type: 'Otro',
          number: '',
        },
        account_holder_name: accountHolderName.trim(),
      },
    };

    if (cbu) {
      (body.destination as any).cbu = String(cbu).replace(/\s/g, '');
    } else if (cvu) {
      (body.destination as any).cvu = String(cvu).replace(/\s/g, '');
    } else if (alias) {
      (body.destination as any).alias = String(alias).trim();
    }

    logger.info('Creando transferencia Mercado Pago', {
      amount: params.amount,
      hasCbu: !!cbu,
      hasCvu: !!cvu,
      hasAlias: !!alias,
      isSandbox: this.isSandbox,
    });

    const response = await fetch(`${this.baseUrl}/v1/money_transfers`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const responseText = await response.text();
    let data: any;
    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch {
      throw new Error(`Error en transferencia MP: ${response.status} - ${responseText}`);
    }

    if (!response.ok) {
      const errMsg = data?.message || data?.error || data?.cause?.description || responseText;
      logger.error('Error en transferencia Mercado Pago', new Error(String(errMsg)), { status: response.status, data });
      throw new Error(errMsg || `Error en transferencia: ${response.status}`);
    }

    return {
      id: data.id || data.transfer_id || String(data),
      status: data.status || 'pending',
    };
  }

  /**
   * Obtiene información del usuario de Mercado Pago usando su access token
   */
  public async getMercadoPagoUser(accessToken: string): Promise<MercadoPagoUser> {
    const response = await fetch(`${this.baseUrl}/users/me`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Error fetching MP user: ${response.status} - ${errorText}`);
    }

    return await response.json() as MercadoPagoUser;
  }
}
