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
  /** What the business chose to spend. Gateway fees are NOT this. */
  | 'expense'
  /** Kashier's cut + VAT + bank fee: withheld from the payment, never an expense. */
  | 'gateway_fee'
  | 'transfer_in'
  | 'transfer_out'
  | 'refund'
  | 'reversal'
  | 'adjustment_in'
  | 'adjustment_out';

/**
 * What an ukkera package sells: the whole course, one chapter, or one
 * instalment — or anything else the owner has since added to `plan_kinds`.
 *
 * The four literals are the codes the name parser writes and the instalment
 * logic branches on, so they stay spelled out and keep their autocompletion.
 * `(string & {})` widens the type without collapsing them, because a kind
 * added at runtime is a perfectly valid value that no build knows about.
 */
export type PackageKind =
  | 'full' | 'chapter' | 'installment' | 'other'
  | (string & {});

/** A plan's progress. `unknown` means the course price has never been set. */
export type PlanStatus = 'closed' | 'unknown' | 'paid' | 'unpaid' | 'partial';

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
  /** Set when the category is a row. Null on entries written before it was. */
  category_id: string | null;
  reference: string | null;
  metadata: Json;
  is_test: boolean;
  transfer_group_id: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
  wallet_delta: number;
  /** Gross student payment. */
  revenue_effect: number;
  expense_effect: number;
  /** What the gateway withheld. Deducted from revenue_effect, not added to expenses. */
  fee_effect: number;
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
  /** Charged / withheld / received, for the payment behind this entry. */
  payment_gross: number | null;
  payment_fees: number | null;
  payment_net: number | null;
  /** The fee itemised: Kashier's commission, the VAT on it, the bank's flat cut. */
  payment_fee_gateway: number | null;
  payment_fee_vat: number | null;
  payment_fee_bank: number | null;
  payment_settled_amount: number | null;
  payment_merchant_order_id: string | null;
  /** ukkera's payment-link id from Kashier metaData — shared by every buyer. */
  payment_link_id: string | null;
  payment_card_brand: string | null;
  payment_masked_card: string | null;
  payment_channel: string | null;
  payment_date: string | null;
  payment_mode: KashierMode | null;
  /** ukkera's transfer id for this purchase — unique, unlike payment_link_id. */
  subscription_transfer_id: string | null;
  package_name: string | null;
  university_name: string | null;
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
  track_id: string | null;
  /** Which Organic they are in. Null means unknown, never "level zero". */
  level: number | null;
  /** True once an admin set the university, track or level by hand. */
  classification_locked: boolean;
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
  track_id: string | null;
  track_name: string | null;
  /**
   * The university and specialisation are read out of the courses a student
   * bought, but only until an admin touches either — from then on they are the
   * admin's, and the classifier leaves the student alone. That is what makes a
   * deliberately cleared field stay cleared.
   */
  classification_locked: boolean;
  /** Open instalment plans, and what is still to collect on them. */
  installment_plans: number;
  installment_remaining: number;
  /** Which Organic they are in. Null when their courses disagree. */
  level: number | null;
  /**
   * What their courses say, as opposed to what is written on them.
   *
   * The three fields above hold one answer each and go null the moment a
   * student's enrolments disagree — correct, and useless for a filter. These
   * carry every value the enrolments actually hold, and the search matches
   * either.
   */
  course_levels: number[];
  course_track_ids: string[];
  course_university_ids: string[];
};

/** `v_levels` — which Organic levels exist, and how much is on each. */
export type LevelRow = {
  level: number;
  courses: number;
  students: number;
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
  plan_kind: PackageKind;
  /** Set when this purchase is one instalment of a larger enrolment. */
  plan_id: string | null;
  /** ukkera's own transfer id. NOT the transfer_id inside Kashier metaData. */
  ukkera_transfer_id: string | null;
  merchant_order_key: string | null;
  plan_total_due: number | null;
  plan_total_paid: number | null;
  plan_remaining: number | null;
  installments_paid: number | null;
  plan_installment_count: number | null;
  next_installment_amount: number | null;
  plan_status: PlanStatus | null;
  university_id: string | null;
  university_label: string | null;
  level: number | null;
  section: string | null;
  class_year: number | null;
  track: string | null;
  track_id: string | null;
  track_name: string | null;
  university_name: string | null;
  package_kind: PackageKind | null;
  installment_seq: number | null;
  chapter_name: string | null;
  /**
   * The next instalment: when, and how much of it is still owed.
   *
   * Null on anything paid in full — "no payment is coming" rather than "the
   * payment is zero". `next_due_in_days` is negative once the date has passed
   * and is computed by the database, so lateness never depends on the
   * viewer's clock.
   */
  next_due_date: string | null;
  next_due_amount: number | null;
  next_due_in_days: number | null;
  /** Which row of the schedule that is. Null when there is no schedule. */
  next_due_seq: number | null;
  /** The kind's display name, so a renamed kind renders as its new name. */
  plan_kind_name: string | null;
  plan_kind_name_en: string | null;
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
  plan_id: string | null;
  plan_kind: PackageKind;
  ukkera_transfer_id: string | null;
  merchant_order_key: string | null;
  /** The first instalment the payments have not reached. Null when none is. */
  next_due_seq: number | null;
  next_due_date: string | null;
  next_due_amount: number | null;
  /** Negative once the date has passed. Computed by the database. */
  next_due_in_days: number | null;
};

export type University = {
  id: string;
  name: string;
  name_key: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

/**
 * التخصص — Clinical, Pharm D and the rest. Same shape as a university on
 * purpose: they are the two things a course title classifies a student by, and
 * every screen that offers one offers the other.
 */
export type Track = University;

/**
 * Course titles arrive from ukkera as one string —
 * "ORGANIC 1 - Azhar Cairo - Girls - 2027 - Clinical" — and are taken apart
 * into these columns on write. A null means that part was not recognised, not
 * that it is absent.
 */
export type Course = {
  id: string;
  name: string;
  name_key: string | null;
  is_active: boolean;
  university_id: string | null;
  created_at: string;
  updated_at: string;
  subject: string | null;
  level: number | null;
  section: string | null;
  class_year: number | null;
  /** The specialisation as the title spelled it, before alias resolution. */
  track: string | null;
  track_id: string | null;
  /** The university as ukkera spelled it, before alias resolution. */
  university_label: string | null;
  ukkera_course_id: string | null;
};

export type CourseCatalogueRow = {
  course_id: string;
  course_name: string;
  is_active: boolean;
  university_id: string | null;
  university_name: string;
  /** Purchases on this course. `enrolled_students` counts people. */
  students_count: number;
  total_due: number;
  total_paid: number;
  remaining: number;
  subject: string | null;
  level: number | null;
  section: string | null;
  class_year: number | null;
  track: string | null;
  university_label: string | null;
  enrolled_students: number;
  installment_plans: number;
  track_id: string | null;
  track_name: string | null;
};

export type Package = {
  id: string;
  course_id: string | null;
  name: string;
  name_key: string | null;
  /** What this package charges. For an instalment package: one instalment. */
  price: number | null;
  created_at: string;
  updated_at: string;
  kind: PackageKind;
  installment_count: number;
  /** Which instalment of the plan this package is, when the title says. */
  installment_seq: number | null;
  /** What the whole course costs through this package. */
  total_price: number | null;
  chapter_name: string | null;
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
  merchant_order_key: string | null;
  ukkera_transfer_id: string | null;
  ukkera_transfer_at: string | null;
  plan_id: string | null;
  plan_kind: PackageKind;
};

/**
 * `v_installment_plans` — one enrolment paid over several purchases.
 *
 * Each instalment arrives as its own ukkera transfer and its own Kashier
 * payment, so each is its own subscription. This is the thing above them that
 * knows the course price, and therefore the only place that can say what is
 * still owed once the first instalment is settled.
 */
export type InstallmentPlan = {
  plan_id: string;
  student_id: string;
  student_name: string | null;
  student_phone: string | null;
  course_id: string | null;
  course_name: string | null;
  package_id: string | null;
  package_name: string | null;
  installment_count: number;
  /** null when the course price has never been set — unknown, not zero. */
  total_due: number | null;
  total_paid: number;
  remaining: number | null;
  installments_paid: number;
  installments_remaining: number;
  next_installment_amount: number | null;
  last_payment_at: string | null;
  started_at: string;
  closed_at: string | null;
  notes: string | null;
  status: PlanStatus;
  /** Agreed with the student, not derived: the instalment is not bought yet. */
  next_due_date: string | null;
  next_due_in_days: number | null;
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
  /** ukkera's payment-LINK id, decoded from the Kashier payload's base64
   *  metaData. Shared by every buyer through that link — never join on it.
   *  The purchase key is merchant_order_key; ukkera's own per-purchase id is
   *  subscriptions.ukkera_transfer_id. */
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
  /** The flat bank fee, which Kashier's own settled_amount does not deduct. */
  bank_fee: number | null;
  /** Everything withheld: commission + VAT on it + bank fee. */
  fees_total: number | null;
  /** What actually arrives. settled_amount is Kashier's figure, before the bank fee. */
  net_after_bank_fee: number | null;
  subscription_transfer_id: string | null;
  plan_id: string | null;
  plan_kind: PackageKind | null;
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

/**
 * The five figures of the P&L, named for what they are:
 *
 *   student_payments - gateway_fees = net_revenue
 *   net_revenue      - expenses     = net_profit
 *
 * There is deliberately no `total_revenue`. It used to mean the gross figure
 * while `net_revenue` meant the real one, and two names for two different
 * numbers is how the gross figure ended up being read as income.
 */
export type DashboardKpis = {
  current_month: string;
  /** What students were charged, before Kashier took its cut. Not income. */
  student_payments: number;
  /** Kashier fee + 14% VAT on it + the flat bank fee. */
  gateway_fees: number;
  /** Income: what actually arrives. */
  net_revenue: number;
  /** What the business chose to spend. Excludes gateway fees. */
  expenses: number;
  net_profit: number;
  month_student_payments: number;
  month_gateway_fees: number;
  month_net_revenue: number;
  month_expenses: number;
  month_net_profit: number;
  outstanding_amount: number;
  students_active: number;
  students_total: number;
  subscriptions_total: number;
  /** Money in your own accounts, kept apart from what Kashier still holds. */
  in_own_wallets: number;
  at_kashier_wallet: number;
  payouts_received: number;
  payouts_in_flight: number;
  unmatched_payments: number;
  unpaid_subscriptions: number;
  failed_ingest_events: number;
  /** Enrolments with instalments still to collect. */
  open_installment_plans: number;
};

/** `revenue` is NET of gateway fees here and everywhere else. */
export type FinanceDaily = {
  day: string;
  revenue: number;
  expenses: number;
  net_profit: number;
  revenue_entries: number;
  expense_entries: number;
  refund_entries: number;
  student_payments: number;
  gateway_fees: number;
  fee_entries: number;
};

export type FinanceMonthly = {
  month: string;
  revenue: number;
  expenses: number;
  net_profit: number;
  revenue_entries: number;
  expense_entries: number;
  student_payments: number;
  gateway_fees: number;
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
  student_payments: number;
  gateway_fees: number;
};

export type RevenueByUniversity = {
  month: string;
  university_id: string | null;
  university_name: string;
  revenue: number;
  payments: number;
  student_payments: number;
  gateway_fees: number;
};

export type RevenueByTrack = {
  month: string;
  track_id: string | null;
  track_name: string;
  revenue: number;
  payments: number;
  student_payments: number;
  gateway_fees: number;
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

/**
 * `v_client_access_audit` — anything the browser client can do that row-level
 * security cannot govern. Empty is the healthy answer; a row means a table got
 * its Supabase default privileges back.
 */
export type ClientAccessAudit = {
  object: string;
  grantee: string;
  finding: string;
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
  /**
   * What Kashier should still be holding, measured the way Kashier measures it:
   * settled_amount, before the bank fee. `awaiting_payout` is what we end up
   * with — a different question, and the wrong one to hold against their
   * reported balance.
   */
  awaiting_settled: number;
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
  /** Gross basis — comparable with Kashier's totalBalance, which is pre-fee. */
  awaiting_payout_gross: number;
  kashier_available: number | null;
  kashier_accounts_returned: string | null;
  /** Kashier's own last payout — ours can be zero when it predates the system. */
  kashier_last_transfer: number | null;
  kashier_last_transfer_at: string | null;
  kashier_last_transfer_ref: string | null;
  our_records_start: string | null;
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
  /** @deprecated Kashier's own figure, taken before the flat bank fee. */
  paid_settled: number | null;
  /** @deprecated Kashier's commission only — no VAT, no bank fee. */
  paid_fees: number | null;
  /** Commission + VAT on it + bank fee. */
  paid_fees_total: number | null;
  /** What actually reaches the account. */
  paid_net: number | null;
  ukkera_transfer_id: string | null;
  plan_id: string | null;
  plan_kind: PackageKind | null;
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
  /** @deprecated Gross. Use `student_payments` — same value, honest name. */
  revenue: number;
  /** @deprecated Kashier's commission only. Use `fees_total`. */
  fees: number;
  /** @deprecated Kashier's own figure, before the flat bank fee. */
  settled: number;
  student_payments: number;
  /** Commission + VAT on it + bank fee. */
  fees_total: number;
  net_received: number;
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

/** `permissions` — the fixed catalogue the code checks. */
export type PermissionRow = {
  code: string;
  domain: string;
  action: 'read' | 'write';
  name: string;
  name_en: string | null;
  sort_order: number;
};

/** `v_roles` — a role, who holds it, and what it may do. */
export type RoleRow = {
  id: string;
  code: string;
  name: string;
  name_en: string | null;
  description: string | null;
  /** Holds every permission implicitly, including ones added later. */
  is_superuser: boolean;
  is_system: boolean;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  members: number;
  permissions: string[];
};

/** `v_staff` — one person's access. */
export type StaffRow = {
  user_id: string;
  email: string;
  full_name: string | null;
  phone: string | null;
  is_active: boolean;
  note: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  created_by_email: string | null;
  role_id: string;
  role_code: string;
  role_name: string;
  role_name_en: string | null;
  is_superuser: boolean;
  role_is_active: boolean;
  /** Whether this row is the person looking at it. */
  is_me: boolean;
};

/** The `expense_categories` table — what a picker needs and nothing more. */
export type ExpenseCategory = {
  id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
};

/**
 * `v_expense_categories` — the same list with the counts that decide whether
 * one can be removed.
 *
 * This used to be a frozen array in this file. It is a table now, because the
 * list is the business's vocabulary and changing it should not be a deploy.
 */
export type ExpenseCategoryRow = {
  id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  entries: number;
  total: number;
  last_used_at: string | null;
};

/** `v_plan_kinds` — what a package can be, and what currently points at each. */
export type PlanKindRow = {
  id: string;
  code: string;
  name: string;
  name_en: string | null;
  /** Seeded and code-bearing: renameable, never deletable. */
  is_system: boolean;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  packages: number;
  subscriptions: number;
};

// --- Payroll -----------------------------------------------------------------

/** Which way a salary line moves the total. */
export type SalaryDirection = 'earning' | 'deduction';

/**
 * Where a month of payroll is up to.
 *
 * Every one of these is branched on here and in the database, which is why it
 * is a fixed union and not a table the owner can extend.
 */
export type PayrollStatus = 'draft' | 'review' | 'approved' | 'closed';

/** `v_employees` — who is on the payroll, and what they have been paid. */
export type EmployeeRow = {
  id: string;
  full_name: string;
  job_title: string | null;
  phone: string | null;
  email: string | null;
  user_id: string | null;
  /**
   * Whether this person can sign in — read off `employees.user_id`, not off
   * the staff join, which needs `staff.read` and would otherwise report "no
   * login" to somebody who simply cannot see the staff list.
   */
  has_login: boolean;
  base_salary: number;
  wallet_id: string | null;
  wallet_name: string | null;
  hired_on: string | null;
  ended_on: string | null;
  is_active: boolean;
  note: string | null;
  created_at: string;
  updated_at: string;
  role_name: string | null;
  role_name_en: string | null;
  payslips: number;
  paid_count: number;
  paid_total: number;
  last_paid_at: string | null;
};

/** `v_salary_components` — the lines a payslip can carry. */
export type SalaryComponentRow = {
  id: string;
  code: string;
  name: string;
  name_en: string | null;
  direction: SalaryDirection;
  /** `commission` and `bonus`: read by name when the message is built. */
  is_system: boolean;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  lines: number;
  total: number;
};

/** `v_payroll_periods` — one month, and how far through it payroll is. */
export type PayrollPeriodRow = {
  id: string;
  /** Always the first of the month. */
  period_month: string;
  status: PayrollStatus;
  note: string | null;
  approved_at: string | null;
  approved_by: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  slips: number;
  paid_count: number;
  gross_total: number;
  net_total: number;
  paid_total: number;
};

/** One line of a payslip, as `v_payslips` embeds it. */
export type PayslipItem = {
  id: string;
  component_id: string;
  code: string;
  /** What this line is for — the component's name unless something better was typed. */
  label: string;
  component_name: string;
  component_name_en: string | null;
  direction: SalaryDirection;
  amount: number;
};

/** `v_payslips` — one person's month, with everything a document needs. */
export type PayslipRow = {
  id: string;
  period_id: string;
  period_month: string;
  period_status: PayrollStatus;
  employee_id: string;
  /** Snapshotted when the payslip was created, so a rename cannot rewrite it. */
  employee_name: string;
  job_title: string | null;
  phone: string | null;
  employee_active: boolean | null;
  base_salary: number;
  earnings_total: number;
  deductions_total: number;
  gross_amount: number;
  net_amount: number;
  /**
   * The two the thank-you message names separately. Defined so that
   * `base + commissions + bonus − deductions = net`, exactly.
   */
  commissions_total: number;
  bonus_total: number;
  note: string | null;
  paid_at: string | null;
  paid_wallet_id: string | null;
  paid_wallet_name: string | null;
  ledger_entry_id: string | null;
  message_sent_at: string | null;
  created_at: string;
  updated_at: string;
  items: PayslipItem[];
};

/** `payroll_settings` — one row, forever. */
export type PayrollSettingsRow = {
  id: boolean;
  company_name: string;
  /** The thank-you note, with {placeholders} this app fills in. */
  thanks_template: string;
  invoice_note: string | null;
  default_wallet_id: string | null;
  expense_category_id: string | null;
  updated_at: string;
};

/** What `pay_payslip` / `unpay_payslip` / `open_payroll_period` answer with. */
export type PayrollResult = {
  ok: boolean;
  reason?: string;
  id?: string;
  status?: string;
  added?: number;
  period_month?: string;
  ledger_entry_id?: string;
  voided_entry_id?: string;
  amount?: number;
  wallet_id?: string;
  paid_at?: string;
};
