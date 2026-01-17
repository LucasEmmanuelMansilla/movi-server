import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import { env } from '../env';
import { logger } from '../utils/logger';
import crypto from 'crypto';

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
        ...(params.payerName ? { name: params.payerName } : {}),
        ...(params.payerIdentification ? { identification: params.payerIdentification } : 
           (this.isSandbox ? { identification: { type: 'DNI', number: '12345678' } } : {})),
      },
      external_reference: params.shipmentId,
      binary_mode: false,
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
    };

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

  public async transferToUser(params: {
    collectorId: string;
    amount: number;
    externalReference: string;
    description: string;
  }) {
    if (!this.client) throw new Error('MP client not initialized');

    const applicationId = env.MP_APPLICATION_ID || env.MP_CLIENT_ID;
    
    const body = {
      application_id: applicationId,
      external_reference: params.externalReference,
      description: params.description,
      processing_mode: 'aggregator',
      binary_mode: true,
      payer: {
        type: 'customer',
      },
      payments: [
        {
          payment_method_id: 'account_money',
          transaction_amount: params.amount,
        }
      ],
      disbursements: [
        {
          collector_id: params.collectorId,
          amount: params.amount,
          external_reference: params.externalReference
        }
      ]
    };

    const response = await fetch(`${this.baseUrl}/v1/advanced_payments`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.MERCADOPAGO_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(`MP Advanced Payment Error: ${JSON.stringify(data)}`);
    return data;
  }
}
