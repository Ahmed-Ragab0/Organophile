'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n/context';
import { useAccess } from '@/lib/access/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { createClient } from '@/lib/supabase/client';
import { dbErrorText } from '@/lib/db-errors';
import { formatDate, formatMoney } from '@/lib/format';
import { monthLabel } from '@/lib/payroll';
import {
  Badge, Button, Card, CardHeader, Checkbox, EmptyState, ErrorState, Field,
  Input, Modal, Notice, PageHeader, PageSkeleton, cx,
} from '@/components/ui/primitives';
import { Money, StatCard } from '@/components/domain';
import type { SpendRequestRow, SpendResult, SpendStatus } from '@/types/database';

/**
 * Money on its way out, and the one person who can let it go.
 *
 * The screen is a queue, not a report: the only rows that need anything are
 * the pending ones, and they are what it opens on. Everything decided is
 * history and sits behind a toggle.
 *
 * Approving is not a signature that authorises somebody to pay later — it IS
 * the payment, in the same transaction as the decision. The confirm says so,
 * because "approve" that quietly means "spend now" is the kind of button
 * people click twice.
 */
export default function ApprovalsPage() {
  const { t, locale } = useI18n();
  const { can } = useAccess();
  const mayDecide = can('approvals.write');

  const [onlyPending, setOnlyPending] = useState(true);
  const [deciding, setDeciding] = useState<{ row: SpendRequestRow; approve: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const requests = useSupabaseQuery<SpendRequestRow[]>(
    (sb) => {
      const q = sb.from('v_spend_requests').select('*').order('created_at', { ascending: false });
      return onlyPending ? q.eq('status', 'pending') : q;
    },
    [onlyPending],
  );

  const reasonText = (reason: string | undefined) => ({
    not_found: t.approvals.reasonNotFound,
    already_decided: t.approvals.reasonAlreadyDecided,
    own_request: t.approvals.reasonOwnRequest,
    not_yours: t.approvals.reasonNotYours,
    amount_changed: t.approvals.reasonAmountChanged,
  }[reason ?? ''] ?? t.common.error);

  async function decide(row: SpendRequestRow, approve: boolean, note: string) {
    setBusy(row.id);
    setError(null);
    const { data, error: err } = await createClient().rpc('decide_spend_request', {
      p_request_id: row.id, p_approve: approve, p_note: note.trim() === '' ? null : note.trim(),
    });
    setBusy(null);
    if (err) { setError(dbErrorText(err, t)); return false; }
    const result = data as SpendResult | null;
    if (!result?.ok) { setError(reasonText(result?.reason)); return false; }
    requests.reload();
    return true;
  }

  async function withdraw(row: SpendRequestRow) {
    if (!window.confirm(t.approvals.confirmCancel)) return;
    setBusy(row.id);
    setError(null);
    const { data, error: err } = await createClient()
      .rpc('cancel_spend_request', { p_request_id: row.id });
    setBusy(null);
    if (err) { setError(dbErrorText(err, t)); return; }
    const result = data as SpendResult | null;
    if (!result?.ok) { setError(reasonText(result?.reason)); return; }
    requests.reload();
  }

  const rows = requests.data ?? [];
  const waiting = rows.filter((r) => r.status === 'pending');
  const waitingTotal = waiting.reduce((s, r) => s + Number(r.amount ?? 0), 0);
  // Yours cannot be decided by you, so they are not part of what is "for you".
  const forMe = mayDecide ? waiting.filter((r) => !r.is_mine) : [];

  if (requests.loading && rows.length === 0) return <PageSkeleton label={t.approvals.title} />;
  if (requests.error) return <ErrorState message={t.common.error} detail={requests.error} />;

  return (
    <>
      <PageHeader
        eyebrow={t.navGroups.money}
        title={t.approvals.title}
        subtitle={t.approvals.subtitle}
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatCard
          label={t.approvals.pending}
          value={waiting.length}
          tone={forMe.length > 0 ? 'warn' : 'neutral'}
          hint={mayDecide && forMe.length > 0
            ? t.approvals.pendingCount.replace('{n}', String(forMe.length))
            : undefined}
        />
        <StatCard label={t.approvals.amount} value={formatMoney(waitingTotal, locale)} emphasis />
        <StatCard label={t.common.total} value={rows.length} />
      </div>

      {error && <div className="mb-3"><Notice tone="danger">{error}</Notice></div>}

      <Card>
        <CardHeader
          title={t.approvals.title}
          hint={mayDecide ? t.approvals.approvedNote : t.approvals.subtitle}
          action={(
            <Checkbox
              checked={onlyPending}
              onChange={setOnlyPending}
              label={t.approvals.onlyPending}
            />
          )}
        />

        {rows.length === 0 ? (
          <EmptyState message={onlyPending ? t.approvals.noneWaiting : t.approvals.noneAtAll} />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium text-ink">{r.description}</span>
                    <Badge tone={r.kind === 'payslip' ? 'brand' : 'neutral'}>
                      {r.kind === 'payslip' ? t.approvals.kindPayslip : t.approvals.kindExpense}
                    </Badge>
                    <StatusPill status={r.status} />
                  </p>

                  <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
                    <span>{t.approvals.requestedBy}: {r.requested_by_name ?? '—'}</span>
                    <span>{t.approvals.fromWallet}: {r.wallet_name}</span>
                    <span>{formatDate(r.occurred_at, locale)}</span>
                    {r.category_name && <span>{r.category_name}</span>}
                    {r.kind === 'payslip' && r.employee_name && r.period_month && (
                      <span>{r.employee_name} · {monthLabel(r.period_month, locale)}</span>
                    )}
                  </p>

                  {r.note && <p className="mt-1 text-xs text-ink-muted">{r.note}</p>}

                  {r.decided_at && (
                    <p className="mt-1 text-xs text-ink-faint">
                      {t.approvals.decidedBy}: {r.decided_by_name ?? '—'}
                      {' · '}{formatDate(r.decided_at, locale)}
                      {r.decision_note && ` · ${r.decision_note}`}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 flex-col items-end gap-2">
                  <span className="font-display text-lg font-semibold">
                    <Money value={r.amount} tone="plain" />
                  </span>

                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    {r.status === 'approved' && r.result_entry_id && (
                      <Link
                        href="/ledger"
                        className="text-xs text-ink-muted underline-offset-2 hover:text-ink hover:underline"
                      >
                        {t.approvals.seeInLedger}
                      </Link>
                    )}

                    {r.status === 'pending' && mayDecide && !r.is_mine && (
                      <>
                        <Button
                          size="sm"
                          disabled={busy === r.id}
                          onClick={() => setDeciding({ row: r, approve: true })}
                        >
                          {t.approvals.approve}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy === r.id}
                          onClick={() => setDeciding({ row: r, approve: false })}
                        >
                          {t.approvals.reject}
                        </Button>
                      </>
                    )}

                    {r.status === 'pending' && r.is_mine && (
                      <>
                        {mayDecide && (
                          <span className="text-xs text-ink-faint">{t.approvals.ownRequestNote}</span>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy === r.id}
                          onClick={() => void withdraw(r)}
                        >
                          {t.approvals.cancel}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {deciding && (
        <DecisionModal
          key={deciding.row.id + String(deciding.approve)}
          row={deciding.row}
          approve={deciding.approve}
          busy={busy === deciding.row.id}
          onClose={() => setDeciding(null)}
          onConfirm={async (note) => {
            const ok = await decide(deciding.row, deciding.approve, note);
            if (ok) setDeciding(null);
          }}
        />
      )}
    </>
  );
}

function StatusPill({ status }: { status: SpendStatus }) {
  const { t } = useI18n();
  const map: Record<SpendStatus, { tone: 'warn' | 'ok' | 'danger' | 'neutral'; label: string }> = {
    pending: { tone: 'warn', label: t.approvals.pending },
    approved: { tone: 'ok', label: t.approvals.approved },
    rejected: { tone: 'danger', label: t.approvals.rejected },
    cancelled: { tone: 'neutral', label: t.approvals.cancelled },
  };
  return <Badge tone={map[status].tone}>{map[status].label}</Badge>;
}

/**
 * The confirm.
 *
 * It spells out the amount and the wallet rather than asking "are you sure?",
 * because the thing being agreed to is a number leaving a named place — and
 * that is exactly what an approver should be reading at the moment they press
 * the button, not what they remember from the row above.
 */
function DecisionModal({
  row, approve, busy, onClose, onConfirm,
}: {
  row: SpendRequestRow;
  approve: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: (note: string) => void;
}) {
  const { t, locale } = useI18n();
  const [note, setNote] = useState('');

  return (
    <Modal
      open
      onClose={onClose}
      title={approve ? t.approvals.approve : t.approvals.reject}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t.common.cancel}</Button>
          <Button
            variant={approve ? 'primary' : 'danger'}
            disabled={busy}
            onClick={() => onConfirm(note)}
          >
            {busy ? t.common.saving : (approve ? t.approvals.approve : t.approvals.reject)}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <div className="rounded-field bg-surface-2 px-3.5 py-3">
          <p className="font-medium text-ink">{row.description}</p>
          <p className="mt-1 text-xs text-ink-faint">
            {t.approvals.requestedBy}: {row.requested_by_name ?? '—'}
          </p>
          <p className="mt-2 flex items-baseline justify-between gap-3">
            <span className="text-xs text-ink-muted">{row.wallet_name}</span>
            <span className={cx('font-display text-xl font-semibold tnum',
              approve ? 'text-danger' : 'text-ink')}>
              {formatMoney(row.amount, locale)}
            </span>
          </p>
        </div>

        {approve ? (
          <Notice tone="warn">
            {t.approvals.confirmApprove
              .replace('{amount}', formatMoney(row.amount, locale))
              .replace('{wallet}', row.wallet_name)}
          </Notice>
        ) : (
          <Notice tone="info">{t.approvals.confirmReject}</Notice>
        )}

        <Field label={t.approvals.decisionNote} hint={t.common.optional}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
