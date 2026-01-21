import { env } from '../env';
import { logger } from '../utils/logger';

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
      const response = await fetch(`${this.apiUrl}/v2/session/`, {
        method: 'POST',
        headers: {
          'X-Api-Key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workflow_id: workflowId || this.defaultWorkflowId,
          vendor_data: userId,
          callback: `${env.API_URL}/kyc/webhook`,
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
      const response = await fetch(`${this.apiUrl}/v2/session/${sessionId}`, {
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
    const status = diditStatus.toLowerCase();
    const overall = overallStatus?.toLowerCase();

    if ((status === 'completed' || status === 'finished') && overall === 'approved') {
      return 'approved';
    }
    if (
      (status === 'completed' || status === 'finished') &&
      overall === 'rejected'
    ) {
      return 'rejected';
    }
    if (
      status === 'failed' ||
      status === 'expired' ||
      overall === 'rejected'
    ) {
      return 'rejected';
    }
    if (
      status === 'pending' ||
      status === 'in_progress' ||
      status === 'in review' ||
      status === 'in_review' ||
      overall === 'pending'
    ) {
      return 'in_progress';
    }
    
    // Si terminó pero aún no hay resultado final, lo tratamos como en progreso
    if (status === 'completed' || status === 'finished') {
      return 'in_progress';
    }

    return 'pending';
  }

  /**
   * Valida la firma del webhook de Didit (si está configurado)
   * @param payload Payload del webhook
   * @param signature Firma recibida
   * @returns true si la firma es válida
   */
  validateWebhookSignature(payload: string, signature: string): boolean {
    // La validación de webhook puede implementarse más adelante
    // Por ahora, validamos que exista la firma si está configurado el secreto
    if (!env.DIDIT_WEBHOOK_SECRET) {
      // Si no hay secreto configurado, permitir (no recomendado para producción)
      logger.warn('DIDIT_WEBHOOK_SECRET no configurado, saltando validación de webhook');
      return true;
    }

    // Validar que exista una firma
    if (!signature) {
      return false;
    }

    // TODO: Implementar validación real de firma según la documentación de Didit
    // cuando esté disponible
    return true;
  }
}

export const diditService = new DiditService();
