export type Role = 'driver' | 'business' | 'admin';
export type ShipmentStatus =
  | 'draft'
  | 'created'
  | 'assigned'
  | 'picked_up'
  | 'in_transit'
  | 'ready_for_delivery'
  | 'delivered'
  | 'cancelled';

// Estados de los trámites de retiro:
// - in_process: creado por el driver, pendiente de acción del administrador
// - closed: el administrador confirmó que el dinero fue enviado
// - cancelled: el trámite fue cancelado, debe tener una razón asociada
export type WithdrawalRequestStatus = 'in_process' | 'closed' | 'cancelled';

export interface WithdrawalRequest {
  id: string;
  user_id: string;
  amount: number;
  status: WithdrawalRequestStatus;
  admin_id: string | null;
  money_sent: boolean | null;
  rejection_reason: string | null;
  admin_notes: string | null;
  created_at: string;
  updated_at: string;
  processed_at: string | null;
}