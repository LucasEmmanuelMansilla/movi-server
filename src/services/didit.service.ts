import { env } from '../env';
import { logger } from '../utils/logger';
import * as crypto from 'crypto';

export type KYCStatus = 'pending' | 'in_progress' | 'approved' | 'rejected';

export interface DiditSessionResponse {
  session_id: string;
  url: string;
  workflow_id: string;
}

export interface DiditSessionData {
  session_id: string;
  status: 'pending' | 'completed' | 'expired' | 'failed';
  verification_result?: {
    document?: {
      type?: string;
      number?: string;
      extracted_data?: {
        first_name?: string;
        last_name?: string;
        birth_date?: string;
        nationality?: string;
      };
    };
    face_match?: {
      result: 'match' | 'no_match' | 'failed';
      confidence?: number;
    };
    overall_status: 'approved' | 'rejected' | 'pending';
  };
}

export class DiditService {
  private apiKey: string;
  private apiUrl: string;
  private defaultWorkflowId: string;

  constructor() {
    this.apiKey = env.DIDIT_API_KEY;
    this.apiUrl = env.DIDIT_API_URL || 'https://verification.didit.me';
    this.defaultWorkflowId = env.DIDIT_WORKFLOW_ID;
  }

  /**
   * Crea una nueva sesión de verificación en Didit
   * @param userId ID del usuario en nuestro sistema
   * @param email Email del usuario (opcional)
   * @param workflowId ID del workflow de verificación (por defecto usa uno estándar de Argentina)
   * @returns URL de la sesión y session_id
   */
  async createVerificationSession(
    userId: string,
    email?: string,
    workflowId?: string
  ): Promise<DiditSessionResponse> {
    try {
      // Usar esquema de URL personalizado para React Native según la guía
      // El callback permite volver a la app al finalizar la verificación
      const callbackUrl = 'movi://didit/callback';
      
      const response = await fetch(`${this.apiUrl}/v3/session/`, {
        method: 'POST',
        headers: {
          'X-Api-Key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workflow_id: workflowId || this.defaultWorkflowId,
          vendor_data: userId,
          callback: callbackUrl, // URL custom para volver a la app
          contact_details: email ? { email } : undefined,
          metadata: {
            user_id: userId,
            country: 'AR',
            document_type: 'DNI',
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('Error creando sesión Didit', new Error(errorText), {
          status: response.status,
          userId,
        });
        throw new Error(`Failed to create Didit session: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      
      logger.info('Sesión Didit creada exitosamente', {
        session_id: data.session_id,
        userId,
      });

      return {
        session_id: data.session_id,
        url: data.url,
        workflow_id: data.workflow_id || workflowId || this.defaultWorkflowId,
      };
    } catch (error: any) {
      logger.error('Error en createVerificationSession', error as Error, { userId });
      throw error;
    }
  }

  /**
   * Obtiene el estado y datos de una sesión de verificación
   * @param sessionId ID de la sesión de Didit
   * @returns Datos completos de la sesión
   */
  async getVerificationStatus(sessionId: string): Promise<DiditSessionData> {
    try {
      // Usar v3 según la guía de integración
      const response = await fetch(`${this.apiUrl}/v3/session/${sessionId}`, {
        method: 'GET',
        headers: {
          'X-Api-Key': this.apiKey,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('Error obteniendo estado de sesión Didit', new Error(errorText), {
          status: response.status,
          sessionId,
        });
        throw new Error(`Failed to get Didit session status: ${response.status}`);
      }

      const data = await response.json();
      return data as DiditSessionData;
    } catch (error: any) {
      logger.error('Error en getVerificationStatus', error as Error, { sessionId });
      throw error;
    }
  }

  /**
   * Obtiene los datos extraídos de la verificación
   * @param sessionId ID de la sesión de Didit
   * @returns Datos extraídos del documento y resultado de face matching
   */
  async getVerificationData(sessionId: string): Promise<DiditSessionData> {
    return this.getVerificationStatus(sessionId);
  }

  /**
   * Convierte el estado de Didit a nuestro formato interno
   * @param diditStatus Estado de Didit
   * @param overallStatus Estado general de verificación
   * @returns Estado interno de KYC
   */
  mapDiditStatusToKYCStatus(
    diditStatus: string,
    overallStatus?: string
  ): KYCStatus {
    const status = diditStatus?.toLowerCase() || '';
    const overall = overallStatus?.toLowerCase() || '';

    // Estados aprobados: si overall_status es 'approved', siempre es aprobado
    // También considerar estados como 'active', 'verified', 'success' como aprobados
    if (overall === 'approved') {
      logger.info('Estado mapeado a approved por overall_status', {
        diditStatus: status,
        overallStatus: overall,
      });
      return 'approved';
    }

    // Estados que indican verificación exitosa/aprobada
    if (
      status === 'active' ||
      status === 'verified' ||
      status === 'success' ||
      status === 'approved' ||
      (status === 'completed' && overall === 'approved') ||
      (status === 'finished' && overall === 'approved')
    ) {
      logger.info('Estado mapeado a approved', {
        diditStatus: status,
        overallStatus: overall,
      });
      return 'approved';
    }

    // Estados rechazados
    if (
      status === 'failed' ||
      status === 'expired' ||
      status === 'rejected' ||
      status === 'declined' ||
      overall === 'rejected' ||
      (status === 'completed' && overall === 'rejected') ||
      (status === 'finished' && overall === 'rejected')
    ) {
      logger.info('Estado mapeado a rejected', {
        diditStatus: status,
        overallStatus: overall,
      });
      return 'rejected';
    }

    // Estados en progreso o en revisión
    if (
      status === 'pending' ||
      status === 'in_progress' ||
      status === 'inprogress' ||
      status === 'in review' ||
      status === 'in_review' ||
      status === 'reviewing' ||
      status === 'processing' ||
      status === 'submitted' ||
      overall === 'pending' ||
      overall === 'in_progress' ||
      overall === 'inprogress'
    ) {
      logger.info('Estado mapeado a in_progress', {
        diditStatus: status,
        overallStatus: overall,
      });
      return 'in_progress';
    }

    // Si terminó (completed/finished) pero aún no hay resultado final definitivo,
    // lo tratamos como en progreso (puede estar esperando revisión manual)
    if (status === 'completed' || status === 'finished') {
      logger.info('Estado completed/finished sin overall_status definitivo, mapeado a in_progress', {
        diditStatus: status,
        overallStatus: overall,
      });
      return 'in_progress';
    }

    // Estado desconocido o no reconocido - loguear para debugging
    if (status) {
      logger.warn('Estado de Didit no reconocido, mapeado a pending', {
        diditStatus: status,
        overallStatus: overall,
      });
    }

    return 'pending';
  }

  /**
   * Valida la firma del webhook de Didit según la guía oficial
   * La firma se calcula como: HMAC SHA256(timestamp + payload) usando WEBHOOK_SECRET_KEY
   * @param payload Payload del webhook (body crudo como string)
   * @param signature Firma recibida en header X-Signature
   * @param timestamp Timestamp recibido en header X-Timestamp
   * @returns true si la firma es válida
   */
  validateWebhookSignature(
    payload: string,
    signature: string,
    timestamp: string
  ): boolean {
    if (!env.DIDIT_WEBHOOK_SECRET) {
      // Si no hay secreto configurado, permitir (no recomendado para producción)
      logger.warn('DIDIT_WEBHOOK_SECRET no configurado, saltando validación de webhook');
      return true;
    }

    // Validar que existan firma y timestamp
    if (!signature || !timestamp) {
      logger.warn('Webhook de Didit sin firma o timestamp', { signature: !!signature, timestamp: !!timestamp });
      return false;
    }

    try {
      // Calcular HMAC SHA256: signature = HMAC_SECRET_KEY(timestamp + payload)
      const hmac = crypto.createHmac('sha256', env.DIDIT_WEBHOOK_SECRET);
      hmac.update(timestamp + payload);
      const digest = hmac.digest('hex');

      // Comparar firmas de forma segura (timing-safe)
      const isValid = crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(digest)
      );

      if (!isValid) {
        logger.warn('Firma de webhook de Didit inválida', {
          expected: digest.substring(0, 8) + '...',
          received: signature.substring(0, 8) + '...',
        });
      }

      return isValid;
    } catch (error: any) {
      logger.error('Error validando firma de webhook de Didit', error as Error);
      return false;
    }
  }
}

export const diditService = new DiditService();
