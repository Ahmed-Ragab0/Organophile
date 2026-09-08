/**
 * Types for the live Supabase schema.
 *
 * Regenerate after a migration with:
 *   supabase gen types typescript --project-id egaaigoplqinjvwtnhoo
 *
 * Money is `number` here because PostgREST returns numeric as a JSON number.
 * Every amount is EGP in major units, matching what Kashier sends.
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

// --- Enums ------------------------------------------------------------------

export type IngestState = 'pending' | 'processed' | 'failed' | 'ignored';
export type KashierMode = 'test' | 'live';
export type KashierTransferEvent =
  | 'INITIATED'
  | 'IN_TRANSIT'
  | 'TRANSFERRED'
  | 'PARTIALLY_TRANSFERRED'
  | 'FAILED';
export type KashierTxnEvent = 'pay' | 'capture' | 'authorize' | 'refund' | 'void' | 'reversal';
export type TxnStatus =
  | 'SUCCESS' | 'FAILURE' | 'PENDING' | 'INITIATED'
  | 'EXPIRED' | 'CANCEL' | 'REVOKED' | 'UNKNOWN';

export type WalletType = 'bank' | 'cash' | 'digital';

export type LedgerEntryType =
  | 'revenue'
  | 'expense'
  | 'transfer_in'
  | 'transfer_out'
  | 'refund'
  | 'reversal'
  | 'adjustment_in'
  | 'adjustment_out';

/** Derived on v_student_financials / v_subscription_financials. */
export type PaymentStatus = 'paid' | 'partial' | 'unpaid' | 'overdue' | 'unknown';

// --- Rows -------------------------------------------------------------------

export type Wallet = {
  id: string;
  name: string;
  name_key: string | null;
  type: WalletType;
  is_active: boolean;
  opening_balance: number;
  sort_order: number;
  is_kashier_default: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type WalletBalance = {
  id: string;
  name: string;
  type: WalletType;
  is_active: boolean;
  sort_order: number;
  is_kashier_default: boolean;
  opening_balance: number;
  balance: number;
  money_in: number;
  money_out: number;
  entries: number;
  last_movement_at: string | null;
};

export type LedgerEntry = {
  id: string;
  entry_type: LedgerEntryType;
  amount: number;
  occurred_at: string;
  description: string | null;
  category: string | null;
  reference: string | null;
  metadata: Json;
  is_test: boolean;
  transfer_group_id: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
  wallet_delta: number;
  revenue_effect: number;
  expense_effect: number;
  wallet_id: string;
  wallet_name: string;
  wallet_type: WalletType;
  student_id: string | null;
  student_name: string | null;
  student_phone: string | null;
  course_id: string | null;
  course_name: string | null;
  subscription_id: string | null;
  subscription_order_id: string | null;
  payment_id: string | null;
  kashier_transaction_id: string | null;
  payment_method: string | null;
  payment_status: TxnStatus | null;
};

export type Student = {
  id: string;
  ukkera_student_id: string | null;
  name: string;
  phone: string | null;
  phone_normalized: string | null;
  email: string | null;
  group_name: string | null;
  university: string | null;
  university_id: string | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type StudentFinancials = {
  student_id: string;
  name: string;
  phone: string | null;
  phone_normalized: string | null;
  email: string | null;
  group_name: string | null;
  is_active: boolean;
  registered_at: string;
  university_id: string | null;
  university_name: string | null;
  subscriptions_count: number;
  total_due: number;
  total_paid: number;
  remaining: number;
  last_payment_at: string | null;
  courses: string | null;
  payment_status: PaymentStatus;
};

/** `v_subscriptions_list` — the subscriptions list, flattened for search. */
export type SubscriptionListRow = {
  subscription_id: string;
  order_id: string;
  source: string;
  enrolled_at: string;
  payment_date: string | null;
  due_date: string | null;
  installment_count: number;
  order_amount: number | null;
  price_override: number | null;
  student_id: string | null;
  student_name: string | null;
  student_phone: string | null;
  student_phone_normalized: string | null;
  course_id: string | null;
  course_name: string | null;
  package_id: string | null;
  package_name: string | null;
  package_price: number | null;
  total_due: number;
  total_paid: number;
  remaining: number;
  payment_status: PaymentStatus | null;
  payments_count: number;
  last_payment_at: string | null;
  price_source: 'override' | 'package' | 'order' | 'none';
};

/** `v_payment_match_health` — how often the order-id hypothesis holds. */
export type PaymentMatchHealth = {
  mode: 'live' | 'test';
  payments: number;
  auto_matched: number;
  manually_linked: number;
  unmatched: number;
  /** Null when there is nothing to measure — not the same as zero. */
  auto_match_rate: number | null;
  oldest_unmatched_at: string | null;
  latest_payment_at: string | null;
};

export type SubscriptionFinancials = {
  subscription_id: string;
  order_id: string;
  student_id: string | null;
  course_id: string | null;
  package_id: string | null;
  enrolled_at: string;
  due_date: string | null;
  installment_count: number;
  total_due: number;
  total_paid: number;
  remaining: number;
  last_payment_at: string | null;
  payments_count: number | null;
  payment_status: PaymentStatus;
};

export type University = {
  id: string;
  name: string;
  name_key: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type Course = {
  id: string;
  name: string;
  name_key: string | null;
  is_active: boolean;
  university_id: string | null;
  created_at: string;
  updated_at: string;
};

export type CourseCatalogueRow = {
  course_id: string;
  course_name: string;
  is_active: boolean;
  university_id: string | null;
  university_name: string;
  students_count: number;
  total_due: number;
  total_paid: number;
  remaining: number;
};

export type Package = {
  id: string;
  course_id: string | null;
  name: string;
  name_key: string | null;
  price: number | null;
  created_at: string;
  updated_at: string;
};

export type Subscription = {
  id: string;
  student_id: string | null;
  course_id: string | null;
  package_id: string | null;
  order_id: string;
  order_key: string | null;
  amount: number | null;
  currency: string;
  payment_date: string | null;
  source: string;
  total_due: number | null;
  installment_count: number;
  due_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * A planned instalment. This is a collection plan, not money: nothing here
 * touches a wallet. What was actually received lives in `ledger_entries`.
 */
export type SubscriptionInstallment = {
  id: string;
  subscription_id: string;
  seq: number;
  amount: number;
  due_date: string | null;
  created_at: string;
};

export type Payment = {
  id: string;
  transaction_id: string;
  kashier_order_id: string | null;
  merchant_order_id: string | null;
  merchant_order_key: string | null;
  /** ukkera's transfer_id, decoded from the Kashier payload's base64 metaData.
   *  This — not merchant_order_id — is what matches subscriptions.order_id. */
  ukkera_transfer_id: string | null;
  ukkera_transfer_key: string | null;
  /** Who paid, from the same metaData. Present even with no ukkera webhook. */
  payer_name: string | null;
  payer_email: string | null;
  payer_phone: string | null;
  payer_phone_normalized: string | null;
  order_reference: string | null;
  event: KashierTxnEvent;
  status: TxnStatus;
  mode: KashierMode;
  amount: number | null;
  currency: string | null;
  settled_amount: number | null;
  fees: number | null;
  vat: number | null;
  method: string | null;
  channel: string | null;
  card_brand: string | null;
  card_holder_name: string | null;
  masked_card: string | null;
  apikey_name: string | null;
  transaction_date: string | null;
  response_code: string | null;
  response_message: string | null;
  is_test_webhook: boolean;
  raw_payload: Json;
  created_at: string;
  updated_at: string;
};

export type EnrichedPayment = {
  id: string | null;
  /** From ukkera's metaData — identifies the payer even with no match. */
  ukkera_transfer_id?: string | null;
  payer_name?: string | null;
  payer_phone?: string | null;
  payer_email?: string | null;
  transaction_id: string | null;
  kashier_order_id: string | null;
  merchant_order_id: string | null;
  order_reference: string | null;
  event: KashierTxnEvent | null;
  status: TxnStatus | null;
  mode: KashierMode | null;
  amount: number | null;
  currency: string | null;
  settled_amount: number | null;
  fees: number | null;
  vat: number | null;
  signed_amount: number | null;
  method: string | null;
  channel: string | null;
  card_brand: string | null;
  masked_card: string | null;
  apikey_name: string | null;
  transaction_date: string | null;
  response_code: string | null;
  response_message: string | null;
  is_test_webhook: boolean | null;
  created_at: string | null;
  updated_at: string | null;
  subscription_id: string | null;
  match_method: string | null;
  subscription_order_id: string | null;
  subscription_payment_date: string | null;
  student_id: string | null;
  student_name: string | null;
  student_phone: string | null;
  student_group: string | null;
  student_university: string | null;
  course_id: string | null;
  course_name: string | null;
  package_id: string | null;
  package_name: string | null;
};

export type Payout = {
  id: string;
  transfer_id: string;
  event: KashierTransferEvent;
  mode: KashierMode;
  amount: number | null;
  currency: string | null;
  reference: string | null;
  transfer_date: string | null;
  method: string | null;
  recipient_name: string | null;
  recipient_number: string | null;
  recipient_bank: string | null;
  merchant_transfer_id: string | null;
  merchant_id: string | null;
  store_name: string | null;
  batch_id: string | null;
  batch_name: string | null;
  batch_transfers_count: number | null;
  response_code: string | null;
  response_message: string | null;
  raw_payload: Json;
  first_seen_at: string;
  created_at: string;
  updated_at: string;
};

export type KashierAccount = {
  mode: KashierMode;
  merchant_id: string | null;
  account_id: string | null;
  merchant_name: string | null;
  total_balance: number | null;
  available_balance: number | null;
  last_transfer: number | null;
  last_transfer_date: string | null;
  payout_method: string | null;
  payout_fields: Json;
  raw_payload: Json;
  synced_at: string;
};

export type DashboardKpis = {
  total_revenue: number;
  total_expenses: number;
  net_profit: number;
  outstanding_amount: number;
  month_revenue: number;
  month_expenses: number;
  month_net_profit: number;
  current_month: string;
  students_active: number;
  students_total: number;
  subscriptions_total: number;
  wallets_total: number;
  unmatched_payments: number;
  unpaid_subscriptions: number;
  failed_ingest_events: number;
  payouts_received: number;
  payouts_in_flight: number;
  /** Kashier fee + VAT + flat bank fee, live only. */
  gateway_fees: number;
  month_gateway_fees: number;
  /** Ledger revenue minus everything Kashier keeps — what actually arrives. */
  net_revenue: number;
  month_net_revenue: number;
  net_after_everything: number;
};

export type FinanceDaily = {
  day: string;
  revenue: number;
  expenses: number;
  net_profit: number;
  revenue_entries: number;
  expense_entries: number;
  refund_entries: number;
};

export type FinanceMonthly = {
  month: string;
  revenue: number;
  expenses: number;
  net_profit: number;
  revenue_entries: number;
  expense_entries: number;
};

export type MonthlyReport = FinanceMonthly & {
  payments_count: number;
  expenses_count: number;
  payments_total: number;
};

export type ExpenseByCategory = {
  month: string;
  category: string;
  total: number;
  entries: number;
};

export type RevenueByCourse = {
  month: string;
  course_id: string | null;
  course_name: string;
  revenue: number;
  payments: number;
};

export type RevenueByUniversity = {
  month: string;
  university_id: string | null;
  university_name: string;
  revenue: number;
  payments: number;
};

export type UnpaidSubscription = {
  id: string | null;
  order_id: string | null;
  amount: number | null;
  payment_date: string | null;
  created_at: string | null;
  student_name: string | null;
  student_phone: string | null;
  course_name: string | null;
};

export type IngestHealth = {
  pipeline: string | null;
  state: string | null;
  events: number | null;
  latest_at: string | null;
  duplicates: number | null;
};

export type PayoutSummary = {
  mode: KashierMode | null;
  event: KashierTransferEvent | null;
  transfers: number | null;
  total_amount: number | null;
  latest_transfer_at: string | null;
};

export type WebhookRejection = {
  id: string;
  endpoint: string;
  reason: string;
  detail: string | null;
  body_sha256: string | null;
  body_excerpt: string | null;
  received_at: string;
};

export type KashierRawEvent = {
  id: string;
  event: string | null;
  resource_type: string;
  mode: KashierMode;
  source: string;
  payload: Json;
  body_sha256: string;
  signature_valid: boolean;
  signature_note: string | null;
  received_at: string;
  state: IngestState;
  processed_at: string | null;
  process_attempts: number;
  process_error: string | null;
  duplicate_count: number;
  last_duplicate_at: string | null;
};

/** Expense categories the business actually uses. */
/**
 * Where the money is, per mode. The four numbers people confuse constantly:
 * gross is what students paid, fees is Kashier's cut, net_settled is what
 * Kashier owes you, and awaiting_payout is what it has not sent yet.
 */
export type KashierFeeSchedule = {
  id: string;
  mode: 'live' | 'test';
  effective_from: string;
  bank_fee_flat: number;
  bank_fee_vat_rate: number;
  note: string | null;
  created_at: string;
  updated_at: string;
};

export type MoneyPosition = {
  mode: KashierMode;
  gross: number;
  refunded: number;
  fees: number;
  net_settled: number;
  payments_count: number;
  transferred: number;
  in_flight: number;
  failed: number;
  transfers_count: number;
  last_transfer_at: string | null;
  awaiting_payout: number;
  /** What Kashier itself reported at the last sync. Null until one succeeds. */
  kashier_reported_balance: number | null;
  kashier_synced_at: string | null;
  /** The flat bank fee Kashier takes but does not report on the transaction. */
  bank_fees: number;
  vat: number;
  /** fees + VAT + bank fee — everything Kashier keeps. */
  total_fees: number;
  /** Gross minus refunds and every Kashier deduction. Agrees with net_settled. */
  net_revenue: number;
  /** What one transaction costs today, per the schedule in force. */
  bank_fee_current: number;
  latest_payment_at: string | null;
  /** Collected but inside Kashier's settlement window — not yet withdrawable. */
  kashier_on_hold: number | null;
  kashier_total_balance: number | null;
  /** The flat fee Kashier itself reports on the account endpoint. */
  kashier_payout_fees: number | null;
  /** Collected after the balance snapshot, so definitionally absent from it. */
  collected_since_sync: number;
  /** Server-computed, so the diagnosis never depends on the viewer's clock. */
  hours_since_latest_payment: number | null;
};

export type GatewayStage = 'not_paid' | 'part_paid' | 'paid';
export type PayoutStage = 'none' | 'at_kashier' | 'partially_paid_out' | 'paid_out';

/** One ukkera order with all three stages of its life on it. */
export type OrderJourney = {
  subscription_id: string;
  order_id: string;
  ordered_at: string;
  order_source: string;
  student_id: string | null;
  student_name: string | null;
  student_phone: string | null;
  course_name: string | null;
  package_name: string | null;
  total_due: number;
  total_paid: number;
  remaining: number;
  payment_status: PaymentStatus;
  kashier_payments: number;
  paid_gross: number | null;
  paid_settled: number | null;
  paid_fees: number | null;
  last_payment_at: string | null;
  latest_transaction_id: string | null;
  latest_mode: KashierMode | null;
  latest_method: string | null;
  match_method: string;
  gateway_stage: GatewayStage;
  payout_stage: PayoutStage;
};

export type RevenueByMethod = {
  month: string;
  method: string;
  payments: number;
  revenue: number;
  fees: number;
  settled: number;
};

export type FeesMonthly = {
  bank_fees?: number;
  total_fees?: number;
  /** Everything Kashier keeps, over gross — the rate that actually bites. */
  effective_fee_rate_pct?: number | null;
  month: string;
  payments: number;
  gross: number;
  fees: number;
  vat: number;
  /** Effective rate Kashier charged, so a change in the schedule is visible. */
  fee_rate_pct: number;
};

export type PayoutsMonthly = {
  month: string;
  mode: KashierMode;
  transfers: number;
  transferred: number;
  in_flight: number;
  failed: number;
};

export const EXPENSE_CATEGORIES = [
  'مرتبات',
  'تسويق',
  'إيجارات',
  'تقنية',
  'إنتاج محتوى',
  'أخرى',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
