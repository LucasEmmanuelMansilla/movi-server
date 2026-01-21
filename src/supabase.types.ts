export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "13.0.5"
  }
  public: {
    Tables: {
      driver_transfers: {
        Row: {
          amount: number
          created_at: string
          driver_id: string
          error_message: string | null
          id: string
          mp_transfer_id: string | null
          notes: string | null
          payment_id: string
          status: string
          transfer_method: string
          transferred_at: string | null
        }
        Insert: {
          amount: number
          created_at?: string
          driver_id: string
          error_message?: string | null
          id?: string
          mp_transfer_id?: string | null
          notes?: string | null
          payment_id: string
          status?: string
          transfer_method?: string
          transferred_at?: string | null
        }
        Update: {
          amount?: number
          created_at?: string
          driver_id?: string
          error_message?: string | null
          id?: string
          mp_transfer_id?: string | null
          notes?: string | null
          payment_id?: string
          status?: string
          transfer_method?: string
          transferred_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "driver_transfers_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_transfers_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
        ]
      },
      driver_assignments: {
        Row: {
          assigned_at: string
          driver_id: string
          id: string
          shipment_id: string
        }
        Insert: {
          assigned_at?: string
          driver_id: string
          id?: string
          shipment_id: string
        }
        Update: {
          assigned_at?: string
          driver_id?: string
          id?: string
          shipment_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_assignments_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_assignments_shipment_id_fkey"
            columns: ["shipment_id"]
            isOneToOne: true
            referencedRelation: "shipments"
            referencedColumns: ["id"]
          },
        ]
      },
      payments: {
        Row: {
          id: string
          shipment_id: string
          payer_id: string
          driver_id: string | null
          status: string
          amount: number
          commission_amount: number
          driver_amount: number
          preference_id: string | null
          payment_id: string | null
          payment_data: Json | null
          paid_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          shipment_id: string
          payer_id: string
          driver_id?: string | null
          status?: string
          amount: number
          commission_amount?: number
          driver_amount?: number
          preference_id?: string | null
          payment_id?: string | null
          payment_data?: Json | null
          paid_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          shipment_id?: string
          payer_id?: string
          driver_id?: string | null
          status?: string
          amount?: number
          commission_amount?: number
          driver_amount?: number
          preference_id?: string | null
          payment_id?: string | null
          payment_data?: Json | null
          paid_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_shipment_id_fkey"
            columns: ["shipment_id"]
            isOneToOne: false
            referencedRelation: "shipments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_payer_id_fkey"
            columns: ["payer_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      },
      profiles: {
        Row: {
          address: string | null
          avatar_url: string | null
          bank_account_holder_name: string | null
          bank_account_number: string | null
          bank_account_type: string | null
          bank_alias: string | null
          bank_cbu: string | null
          bank_cvu: string | null
          bank_name: string | null
          business_address: string | null
          business_name: string | null
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          is_available: boolean | null
          last_location_updated: string | null
          latitude: number | null
          license_number: string | null
          longitude: number | null
          mp_access_token: string | null
          mp_refresh_token: string | null
          mp_status: string | null
          mp_token_expires_at: string | null
          mp_user_id: string | null
          phone: string | null
          role: string
          updated_at: string | null
          vehicle_plate: string | null
          vehicle_type: string | null
          kyc_status: string | null
          kyc_didit_session_id: string | null
          kyc_validated_at: string | null
          kyc_document_number: string | null
          kyc_document_type: string | null
          kyc_first_name: string | null
          kyc_last_name: string | null
          kyc_birth_date: string | null
          kyc_nationality: string | null
        }
        Insert: {
          address?: string | null
          avatar_url?: string | null
          bank_account_holder_name?: string | null
          bank_account_number?: string | null
          bank_account_type?: string | null
          bank_alias?: string | null
          bank_cbu?: string | null
          bank_cvu?: string | null
          bank_name?: string | null
          business_address?: string | null
          business_name?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id: string
          is_available?: boolean | null
          last_location_updated?: string | null
          latitude?: number | null
          license_number?: string | null
          longitude?: number | null
          mp_access_token?: string | null
          mp_refresh_token?: string | null
          mp_status?: string | null
          mp_token_expires_at?: string | null
          mp_user_id?: string | null
          phone?: string | null
          role: string
          updated_at?: string | null
          vehicle_plate?: string | null
          vehicle_type?: string | null
          kyc_status?: string | null
          kyc_didit_session_id?: string | null
          kyc_validated_at?: string | null
          kyc_document_number?: string | null
          kyc_document_type?: string | null
          kyc_first_name?: string | null
          kyc_last_name?: string | null
          kyc_birth_date?: string | null
          kyc_nationality?: string | null
        }
        Update: {
          address?: string | null
          avatar_url?: string | null
          bank_account_holder_name?: string | null
          bank_account_number?: string | null
          bank_account_type?: string | null
          bank_alias?: string | null
          bank_cbu?: string | null
          bank_cvu?: string | null
          bank_name?: string | null
          business_address?: string | null
          business_name?: string | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          is_available?: boolean | null
          last_location_updated?: string | null
          latitude?: number | null
          license_number?: string | null
          longitude?: number | null
          mp_access_token?: string | null
          mp_refresh_token?: string | null
          mp_status?: string | null
          mp_token_expires_at?: string | null
          mp_user_id?: string | null
          phone?: string | null
          role?: string
          updated_at?: string | null
          vehicle_plate?: string | null
          vehicle_type?: string | null
          kyc_status?: string | null
          kyc_didit_session_id?: string | null
          kyc_validated_at?: string | null
          kyc_document_number?: string | null
          kyc_document_type?: string | null
          kyc_first_name?: string | null
          kyc_last_name?: string | null
          kyc_birth_date?: string | null
          kyc_nationality?: string | null
        }
        Relationships: []
      },
      push_tokens: {
        Row: {
          created_at: string
          id: string
          platform: string | null
          token: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          platform?: string | null
          token: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          platform?: string | null
          token?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_tokens_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      },
      shipment_statuses: {
        Row: {
          created_at: string
          created_by: string
          id: string
          note: string | null
          shipment_id: string
          status: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          note?: string | null
          shipment_id: string
          status: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          note?: string | null
          shipment_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "shipment_statuses_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipment_statuses_shipment_id_fkey"
            columns: ["shipment_id"]
            isOneToOne: false
            referencedRelation: "shipments"
            referencedColumns: ["id"]
          },
        ]
      },
      shipments: {
        Row: {
          created_at: string
          created_by: string
          current_status: string
          description: string | null
          dropoff_address: string
          id: string
          pickup_address: string
          price: number | null
          title: string
          weight: number
        }
        Insert: {
          created_at?: string
          created_by: string
          current_status?: string
          description?: string | null
          dropoff_address: string
          id?: string
          pickup_address: string
          price?: number | null
          title: string
          weight: number
        }
        Update: {
          created_at?: string
          created_by?: string
          current_status?: string
          description?: string | null
          dropoff_address?: string
          id?: string
          pickup_address?: string
          price?: number | null
          title?: string
          weight?: number
        }
        Relationships: [
          {
            foreignKeyName: "shipments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      },
      messages: {
        Row: {
          id: string
          shipment_id: string
          sender_id: string
          receiver_id: string
          content: string
          created_at: string
          read_at: string | null
        }
        Insert: {
          id?: string
          shipment_id: string
          sender_id: string
          receiver_id: string
          content: string
          created_at?: string
          read_at?: string | null
        }
        Update: {
          id?: string
          shipment_id?: string
          sender_id?: string
          receiver_id?: string
          content?: string
          created_at?: string
          read_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "messages_shipment_id_fkey"
            columns: ["shipment_id"]
            isOneToOne: false
            referencedRelation: "shipments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_receiver_id_fkey"
            columns: ["receiver_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
