export type Role = 'driver' | 'business' | 'admin';
export type ShipmentStatus = 'draft' | 'created' | 'assigned' | 'picked_up' | 'in_transit' | 'ready_for_delivery' | 'delivered' | 'cancelled';
export type WithdrawalRequestStatus = 'pending' | 'completed' | 'rejected' | 'cancelled';

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