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
  status: string; // 'pending', 'completed', 'expired', 'failed', 'Approved', 'Declined', etc.
  url?: string;
  vendor_data?: string;
  workflow_id?: string;
  metadata?: any;
  decision?: {
    status: string; // 'Approved', 'Declined', 'In Review', 'Abandoned', etc.
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
  };
  verification_result?: any; // Mantener por compatibilidad con v2/webhooks
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
   * Intenta usar el endpoint /decision/ para obtener el resultado real
   * @param sessionId ID de la sesión de Didit
   * @returns Datos completos de la sesión
   */
  async getVerificationStatus(sessionId: string): Promise<DiditSessionData> {
    try {
      // Intentar primero con el endpoint /decision/ que es el que tiene el resultado real
      const decisionResponse = await fetch(`${this.apiUrl}/v2/session/${sessionId}/decision/`, {
        method: 'GET',
        headers: {
          'X-Api-Key': this.apiKey,
        },
      });

      if (decisionResponse.ok) {
        const decisionData = await decisionResponse.json();
        logger.info('Decisión de Didit obtenida exitosamente', {
          session_id: sessionId,
          status: decisionData.status,
          hasDecision: !!decisionData.decision,
        });
        return decisionData as DiditSessionData;
      }

      // Si falla /decision/, intentar con /v3/session/ por compatibilidad
      logger.warn('Fallo al obtener decisión, intentando con endpoint v3 de sesión', {
        status: decisionResponse.status,
        sessionId,
      });

      const sessionResponse = await fetch(`${this.apiUrl}/v3/session/${sessionId}`, {
        method: 'GET',
        headers: {
          'X-Api-Key': this.apiKey,
        },
      });

      if (!sessionResponse.ok) {
        const errorText = await sessionResponse.text();
        logger.error('Error obteniendo estado de sesión Didit en ambos endpoints', new Error(errorText), {
          status: sessionResponse.status,
          sessionId,
        });
        throw new Error(`Failed to get Didit session status: ${sessionResponse.status}`);
      }

      const sessionData = await sessionResponse.json();
      return sessionData as DiditSessionData;
    } catch (error: any) {
      logger.error('Error en getVerificationStatus', error as Error, { sessionId });
      throw error;
    }
  }

  /**
   * Obtiene específicamente la decisión de una sesión
   * @param sessionId ID de la sesión
   */
  async getVerificationDecision(sessionId: string): Promise<DiditSessionData> {
    return this.getVerificationStatus(sessionId);
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
   * @param diditStatus Estado de Didit (puede venir de status o decision.status)
   * @param overallStatus Estado general de verificación (opcional)
   * @param decisionStatus Estado del objeto decision (opcional)
   * @returns Estado interno de KYC
   */
  mapDiditStatusToKYCStatus(
    diditStatus: string,
    overallStatus?: string,
    decisionStatus?: string
  ): KYCStatus {
    // Normalizar estados a minúsculas para comparar, pero aceptar mayúsculas
    const status = diditStatus?.toLowerCase() || '';
    const overall = overallStatus?.toLowerCase() || '';
    const decision = decisionStatus?.toLowerCase() || '';

    logger.debug('Mapeando estado de Didit', { status, overall, decision });

    // Estados aprobados: si overall_status o decision.status es 'approved', siempre es aprobado
    if (overall === 'approved' || decision === 'approved' || status === 'approved' || status === 'verified' || status === 'active') {
      return 'approved';
    }

    // Casos específicos de Didit que significan éxito
    if (
      status === 'success' ||
      (status === 'completed' && (overall === 'approved' || decision === 'approved')) ||
      (status === 'finished' && (overall === 'approved' || decision === 'approved'))
    ) {
      return 'approved';
    }

    // Estados rechazados
    if (
      status === 'failed' ||
      status === 'expired' ||
      status === 'rejected' ||
      status === 'declined' ||
      overall === 'rejected' ||
      decision === 'rejected' ||
      decision === 'declined' ||
      (status === 'completed' && (overall === 'rejected' || decision === 'declined')) ||
      (status === 'finished' && (overall === 'rejected' || decision === 'declined'))
    ) {
      return 'rejected';
    }

    // Estados en revisión/espera (no abrir WebView automáticamente)
    if (
      status === 'in review' ||
      status === 'in_review' ||
      status === 'reviewing' ||
      status === 'processing' ||
      decision === 'in review' ||
      decision === 'in_review' ||
      overall === 'in review' ||
      overall === 'in_review'
    ) {
      return 'in_progress';
    }

    // Estados en progreso (usuario aún en el WebView)
    if (
      status === 'pending' ||
      status === 'in_progress' ||
      status === 'inprogress' ||
      status === 'submitted' ||
      status === 'not started' ||
      status === 'not_started' ||
      overall === 'pending' ||
      overall === 'in_progress'
    ) {
      return 'in_progress';
    }

    // Si terminó pero no hay resultado final definitivo
    if (status === 'completed' || status === 'finished') {
      return 'in_progress';
    }

    // Por defecto, si hay algún estado, tratar como en progreso, si no pendiente
    return status ? 'in_progress' : 'pending';
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
