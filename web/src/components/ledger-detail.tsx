'use client';

import Link from 'next/link';
import { useI18n } from '@/lib/i18n/context';
import { formatDateTime, formatMoney } from '@/lib/format';
import { Badge, Modal } from '@/components/ui/primitives';
import { LedgerTypeBadge, Money } from '@/components/domain';
import type { LedgerEntry } from '@/types/database';

/** A label/value pair. Nulls are dropped by the caller, not rendered as "—". */
function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <span className="shrink-0 text-xs text-ink-muted">{label}</span>
      <span className="min-w-0 text-end text-sm text-ink">{value}</span>
    </div>
  );
}

function Id({ value }: { value: string | null | undefined }) {
  if (!value) return null;
  return <span className="ltr-id break-all text-xs text-ink-muted">{value}</span>;
}

/**
 * Everything behind one line of the ledger.
 *
 * The list can only afford three numbers per row, and the fee is the one that
 * always raises a question — 9.33 of what, taken by whom. This is where that is
 * answered: the commission, the VAT charged on the commission, and the bank's
 * flat five pounds, added up in front of the reader rather than asserted.
 */
export function LedgerDetailModal({
  entry, onClose,
}: { entry: LedgerEntry | null; onClose: () => void }) {
  const { t, locale } = useI18n();
  if (!entry) return null;

  const e = entry;
  const n = (v: number | null | undefined) => (v === null || v === undefined ? null : Number(v));
  const gross = n(e.payment_gross);
  const fees = n(e.payment_fees);
  const net = n(e.payment_net);

  const feeParts = [
    { label: t.ledgerDetail.commission, value: n(e.payment_fee_gateway) },
    { label: t.ledgerDetail.vat, value: n(e.payment_fee_vat) },
    { label: t.ledgerDetail.bankFee, value: n(e.payment_fee_bank) },
  ].filter((f) => f.value !== null && f.value !== 0);

  return (
    <Modal open onClose={onClose} title={e.description ?? t.ledgerDetail.title}>
      <div className="space-y-5 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <LedgerTypeBadge type={e.entry_type} />
          {e.is_test && <Badge tone="warn">{t.common.test}</Badge>}
          {e.voided_at && <Badge tone="danger">{t.ledger.voided}</Badge>}
          <span className="text-xs text-ink-muted">
            {formatDateTime(e.payment_date ?? e.occurred_at, locale)}
          </span>
        </div>

        {/* The subtraction, spelled out. */}
        {gross !== null && (
          <div className="rounded-panel border border-border bg-surface-2 p-4">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-sm text-ink-muted">{t.finance.paidByStudent}</span>
              <span className="font-display text-lg font-semibold text-ink tnum">
                {formatMoney(gross, locale)}
              </span>
            </div>

            <div className="mt-3 space-y-1.5 border-y border-border py-3">
              {feeParts.map((f) => (
                <div key={f.label} className="flex items-baseline justify-between gap-4">
                  <span className="text-xs text-ink-muted">{f.label}</span>
                  <span className="text-sm text-danger tnum">
                    − {formatMoney(f.value as number, locale)}
                  </span>
                </div>
              ))}
              <div className="flex items-baseline justify-between gap-4 pt-1">
                <span className="text-xs font-medium text-ink">{t.finance.feeTaken}</span>
                <span className="text-sm font-semibold text-danger tnum">
                  − {formatMoney(fees ?? 0, locale)}
                </span>
              </div>
            </div>

            <div className="mt-3 flex items-baseline justify-between gap-4">
              <span className="text-sm font-semibold text-ink">{t.finance.youReceived}</span>
              <span className="font-display text-2xl font-semibold text-ok tnum">
                {formatMoney(net ?? 0, locale)}
              </span>
            </div>
            <p className="mt-1.5 text-xs text-ink-faint">{t.finance.feesNotExpense}</p>
          </div>
        )}

        <div className="divide-y divide-border">
          {e.student_name && (
            <Row
              label={t.ledger.student}
              value={e.student_id
                ? (
                  <Link
                    href={`/students/${e.student_id}`}
                    className="font-medium text-accent-strong hover:underline"
                  >
                    {e.student_name}
                  </Link>
                )
                : e.student_name}
            />
          )}
          {e.student_phone && <Row label={t.students.phone} value={<Id value={e.student_phone} />} />}
          {e.course_name && <Row label={t.subscriptions.course} value={e.course_name} />}
          {e.university_name && <Row label={t.courseInfo.university} value={e.university_name} />}
          {e.package_name && <Row label={t.subscriptions.package} value={e.package_name} />}
          <Row label={t.ledger.wallet} value={e.wallet_name} />
          <Row
            label={t.ledger.effect}
            value={<Money value={Number(e.wallet_delta ?? 0)} tone="plain" />}
          />
          {e.payment_method && (
            <Row
              label={t.payouts.method}
              value={[e.payment_method, e.payment_card_brand, e.payment_masked_card]
                .filter(Boolean).join(' · ')}
            />
          )}
          {e.payment_channel && <Row label={t.ledgerDetail.channel} value={e.payment_channel} />}
          {e.payment_settled_amount !== null && (
            <Row
              label={t.ledgerDetail.settledByKashier}
              value={<Money value={Number(e.payment_settled_amount)} tone="plain" />}
            />
          )}
        </div>

        {/* The identifiers, together, because tracing a purchase means holding
            all of them at once — and because two of them are called
            "transfer id" by different systems and mean different things. */}
        <div>
          <p className="mb-1 text-xs font-medium text-ink-muted">{t.ledgerDetail.identifiers}</p>
          <div className="divide-y divide-border rounded-field border border-border px-3">
            {e.kashier_transaction_id && (
              <Row label={t.payments.transactionId} value={<Id value={e.kashier_transaction_id} />} />
            )}
            {e.payment_merchant_order_id && (
              <Row label={t.ledgerDetail.merchantOrderId} value={<Id value={e.payment_merchant_order_id} />} />
            )}
            {e.subscription_transfer_id && (
              <Row label={t.ledgerDetail.ukkeraTransfer} value={<Id value={e.subscription_transfer_id} />} />
            )}
            {e.payment_link_id && (
              <Row label={t.ledgerDetail.ukkeraLink} value={<Id value={e.payment_link_id} />} />
            )}
            {e.subscription_id && (
              <Row
                label={t.subscriptions.orderId}
                value={(
                  <Link
                    href={`/pricing/${e.subscription_id}`}
                    className="font-medium text-accent-strong hover:underline"
                  >
                    {t.pricing.openEditor} →
                  </Link>
                )}
              />
            )}
          </div>
          {e.payment_link_id && (
            <p className="mt-1.5 text-xs text-ink-faint">{t.ledgerDetail.linkIdWarning}</p>
          )}
        </div>

        {e.void_reason && (
          <div className="rounded-field border border-danger/30 bg-danger/5 p-3">
            <p className="text-xs font-medium text-danger">{t.ledger.voidReason}</p>
            <p className="mt-1 text-sm text-ink">{e.void_reason}</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
