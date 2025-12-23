/**
 * Tipos temporales para la tabla de pagos
 * TODO: Actualizar supabase.types.ts después de ejecutar la migración SQL
 */

export interface Payment {
  id: string;
  shipment_id: string;
  payer_id: string;
  driver_id: string | null;
  status: 'pending' | 'approved' | 'cancelled' | 'refunded';
  amount: number;
  commission_amount: number;
  driver_amount: number;
  preference_id: string | null;
  payment_id: string | null;
  payment_data: any | null; // JSONB
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentInsert {
  shipment_id: string;
  payer_id: string;
  driver_id?: string | null;
  status?: 'pending' | 'approved' | 'cancelled' | 'refunded';
  amount: number;
  commission_amount: number;
  driver_amount: number;
  preference_id?: string | null;
  payment_id?: string | null;
  payment_data?: any | null;
  paid_at?: string | null;
}

export interface PaymentUpdate {
  driver_id?: string | null;
  status?: 'pending' | 'approved' | 'cancelled' | 'refunded';
  payment_id?: string | null;
  payment_data?: any | null;
  paid_at?: string | null;
}

