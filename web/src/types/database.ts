/**
 * Generated from the live Supabase schema.
 *
 * Regenerate after any migration. With the Supabase CLI linked to this
 * project:  supabase gen types typescript --project-id egaaigoplqinjvwtnhoo
 * Do not edit by hand — changes here will be overwritten.
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type IngestState = 'pending' | 'processed' | 'failed' | 'ignored';
export type KashierMode = 'test' | 'live';
export type KashierTransferEvent = 'INITIATED' | 'TRANSFERRED' | 'FAILED';
export type KashierTxnEvent = 'pay' | 'capture' | 'authorize' | 'refund' | 'void' | 'reversal';
export type TxnStatus =
  | 'SUCCESS' | 'FAILURE' | 'PENDING' | 'INITIATED'
  | 'EXPIRED' | 'CANCEL' | 'REVOKED' | 'UNKNOWN';

export type Database = {
  public: {
    Tables: {
      admin_users: {
        Row: { created_at: string; email: string | null; user_id: string };
        Insert: { created_at?: string; email?: string | null; user_id: string };
        Update: { created_at?: string; email?: string | null; user_id?: string };
        Relationships: [];
      };
      courses: {
        Row: {
          created_at: string; id: string; is_active: boolean;
          name: string; name_key: string | null; updated_at: string;
        };
        Insert: {
          created_at?: string; id?: string; is_active?: boolean;
          name: string; updated_at?: string;
        };
        Update: {
          created_at?: string; id?: string; is_active?: boolean;
          name?: string; updated_at?: string;
        };
        Relationships: [];
      };
      expenses: {
        Row: {
          amount: number; category: string; created_at: string; created_by: string | null;
          currency: string; id: string; note: string | null; spent_at: string; updated_at: string;
        };
        Insert: {
          amount: number; category: string; created_at?: string; created_by?: string | null;
          currency?: string; id?: string; note?: string | null; spent_at?: string;
          updated_at?: string;
        };
        Update: {
          amount?: number; category?: string; created_at?: string; created_by?: string | null;
          currency?: string; id?: string; note?: string | null; spent_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      kashier_events_raw: {
        Row: {
          body_sha256: string; duplicate_count: number; event: string | null; id: string;
          last_duplicate_at: string | null; mode: KashierMode; payload: Json;
          process_attempts: number; process_error: string | null; processed_at: string | null;
          received_at: string; resource_type: string; signature_note: string | null;
          signature_valid: boolean; source: string; state: IngestState;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      packages: {
        Row: {
          course_id: string | null; created_at: string; id: string; name: string;
          name_key: string | null; price: number | null; updated_at: string;
        };
        Insert: {
          course_id?: string | null; created_at?: string; id?: string; name: string;
          price?: number | null; updated_at?: string;
        };
        Update: {
          course_id?: string | null; created_at?: string; id?: string; name?: string;
          price?: number | null; updated_at?: string;
        };
        Relationships: [];
      };
      payment_subscription_overrides: {
        Row: {
          created_at: string; created_by: string | null; payment_id: string;
          reason: string | null; subscription_id: string;
        };
        Insert: {
          created_at?: string; created_by?: string | null; payment_id: string;
          reason?: string | null; subscription_id: string;
        };
        Update: {
          created_at?: string; created_by?: string | null; payment_id?: string;
          reason?: string | null; subscription_id?: string;
        };
        Relationships: [];
      };
      payments: {
        Row: {
          amount: number | null; apikey_name: string | null; card_brand: string | null;
          card_holder_name: string | null; channel: string | null; created_at: string;
          currency: string | null; event: KashierTxnEvent; fees: number | null;
          first_seen_at: string; id: string; is_test_webhook: boolean;
          kashier_order_id: string | null; masked_card: string | null;
          merchant_order_id: string | null; merchant_order_key: string | null;
          method: string | null; mode: KashierMode; order_reference: string | null;
          raw_payload: Json; response_code: string | null; response_message: string | null;
          settled_amount: number | null; status: TxnStatus; transaction_date: string | null;
          transaction_id: string; updated_at: string; vat: number | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      payouts: {
        Row: {
          amount: number | null; created_at: string; currency: string | null;
          event: KashierTransferEvent; first_seen_at: string; id: string; mode: KashierMode;
          raw_payload: Json; reference: string | null; transfer_date: string | null;
          transfer_id: string; updated_at: string;
          // Captured from the real Kashier transfer payload (migration 0009).
          method: string | null; recipient_name: string | null;
          recipient_number: string | null; merchant_transfer_id: string | null;
          response_code: string | null; response_message: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      students: {
        Row: {
          created_at: string; email: string | null; group_name: string | null; id: string;
          name: string; notes: string | null; phone: string | null;
          phone_normalized: string | null; ukkera_student_id: string | null;
          university: string | null; updated_at: string;
        };
        Insert: {
          created_at?: string; email?: string | null; group_name?: string | null; id?: string;
          name: string; notes?: string | null; phone?: string | null;
          ukkera_student_id?: string | null; university?: string | null; updated_at?: string;
        };
        Update: {
          created_at?: string; email?: string | null; group_name?: string | null; id?: string;
          name?: string; notes?: string | null; phone?: string | null;
          ukkera_student_id?: string | null; university?: string | null; updated_at?: string;
        };
        Relationships: [];
      };
      subscriptions: {
        Row: {
          amount: number | null; course_id: string | null; created_at: string; currency: string;
          id: string; order_id: string; order_key: string | null; package_id: string | null;
          payment_date: string | null; source: string; student_id: string | null;
          updated_at: string;
        };
        Insert: {
          amount?: number | null; course_id?: string | null; created_at?: string;
          currency?: string; id?: string; order_id: string; package_id?: string | null;
          payment_date?: string | null; source?: string; student_id?: string | null;
          updated_at?: string;
        };
        Update: {
          amount?: number | null; course_id?: string | null; created_at?: string;
          currency?: string; id?: string; order_id?: string; package_id?: string | null;
          payment_date?: string | null; source?: string; student_id?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      ukkera_events_raw: {
        Row: {
          body_sha256: string; duplicate_count: number; id: string;
          last_duplicate_at: string | null; payload: Json; process_attempts: number;
          process_error: string | null; processed_at: string | null; received_at: string;
          state: IngestState;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      webhook_rejections: {
        Row: {
          body_excerpt: string | null; body_sha256: string | null; detail: string | null;
          endpoint: string; id: string; reason: string; received_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Views: {
      v_dashboard_kpis: {
        Row: {
          expenses_all_time: number | null; failed_ingest_events: number | null;
          payouts_in_flight: number | null; payouts_transferred: number | null;
          revenue_all_time: number | null; revenue_this_month: number | null;
          students_total: number | null; subscriptions_total: number | null;
          unmatched_payments: number | null; unpaid_subscriptions: number | null;
        };
        Relationships: [];
      };
      v_expenses_daily: {
        Row: { day: string | null; entries: number | null; expenses: number | null };
        Relationships: [];
      };
      v_ingest_health: {
        Row: {
          duplicates: number | null; events: number | null; latest_at: string | null;
          pipeline: string | null; state: string | null;
        };
        Relationships: [];
      };
      v_payment_matches: {
        Row: {
          match_method: string | null; payment_id: string | null; subscription_id: string | null;
        };
        Relationships: [];
      };
      v_payments_enriched: {
        Row: {
          amount: number | null; apikey_name: string | null; card_brand: string | null;
          channel: string | null; course_id: string | null; course_name: string | null;
          created_at: string | null; currency: string | null; event: KashierTxnEvent | null;
          fees: number | null; id: string | null; is_test_webhook: boolean | null;
          kashier_order_id: string | null; masked_card: string | null;
          match_method: string | null; merchant_order_id: string | null; method: string | null;
          mode: KashierMode | null; order_reference: string | null; package_id: string | null;
          package_name: string | null; response_code: string | null;
          response_message: string | null; settled_amount: number | null;
          signed_amount: number | null; status: TxnStatus | null; student_group: string | null;
          student_id: string | null; student_name: string | null; student_phone: string | null;
          student_university: string | null; subscription_id: string | null;
          subscription_order_id: string | null; subscription_payment_date: string | null;
          transaction_date: string | null; transaction_id: string | null;
          updated_at: string | null; vat: number | null;
        };
        Relationships: [];
      };
      v_payout_summary: {
        Row: {
          event: KashierTransferEvent | null; latest_transfer_at: string | null;
          mode: KashierMode | null; total_amount: number | null; transfers: number | null;
        };
        Relationships: [];
      };
      v_profit_daily: {
        Row: {
          day: string | null; expenses: number | null; fees: number | null;
          net_profit: number | null; revenue: number | null;
        };
        Relationships: [];
      };
      v_revenue_daily: {
        Row: {
          day: string | null; failed_payments: number | null; fees: number | null;
          gross: number | null; mode: KashierMode | null; refunds: number | null;
          settled: number | null; successful_payments: number | null;
        };
        Relationships: [];
      };
      v_revenue_monthly: {
        Row: {
          expenses: number | null; fees: number | null; month: string | null;
          net_profit: number | null; revenue: number | null;
        };
        Relationships: [];
      };
      v_unmatched_payments: {
        Row: Database['public']['Views']['v_payments_enriched']['Row'];
        Relationships: [];
      };
      v_unpaid_subscriptions: {
        Row: {
          amount: number | null; course_name: string | null; created_at: string | null;
          id: string | null; order_id: string | null; payment_date: string | null;
          student_name: string | null; student_phone: string | null;
        };
        Relationships: [];
      };
    };
    Functions: {
      sweep_failed_events: { Args: Record<string, never>; Returns: Json };
    };
    Enums: {
      kashier_mode: KashierMode;
      kashier_transfer_event: KashierTransferEvent;
      kashier_txn_event: KashierTxnEvent;
      txn_status: TxnStatus;
    };
    CompositeTypes: Record<string, never>;
  };
};

type PublicSchema = Database['public'];

export type Tables<T extends keyof (PublicSchema['Tables'] & PublicSchema['Views'])> =
  (PublicSchema['Tables'] & PublicSchema['Views'])[T] extends { Row: infer R } ? R : never;

export type TablesInsert<T extends keyof PublicSchema['Tables']> =
  PublicSchema['Tables'][T] extends { Insert: infer I } ? I : never;

export type TablesUpdate<T extends keyof PublicSchema['Tables']> =
  PublicSchema['Tables'][T] extends { Update: infer U } ? U : never;

// --- Convenience aliases used across the app --------------------------------
export type Student = Tables<'students'>;
export type Course = Tables<'courses'>;
export type Package = Tables<'packages'>;
export type Subscription = Tables<'subscriptions'>;
export type Payment = Tables<'payments'>;
export type Payout = Tables<'payouts'>;
export type Expense = Tables<'expenses'>;
export type EnrichedPayment = Tables<'v_payments_enriched'>;
export type UnpaidSubscription = Tables<'v_unpaid_subscriptions'>;
export type DashboardKpis = Tables<'v_dashboard_kpis'>;
export type ProfitDaily = Tables<'v_profit_daily'>;
export type RevenueMonthly = Tables<'v_revenue_monthly'>;
export type IngestHealth = Tables<'v_ingest_health'>;
export type PayoutSummary = Tables<'v_payout_summary'>;
export type WebhookRejection = Tables<'webhook_rejections'>;
export type KashierRawEvent = Tables<'kashier_events_raw'>;
export type UkkeraRawEvent = Tables<'ukkera_events_raw'>;
