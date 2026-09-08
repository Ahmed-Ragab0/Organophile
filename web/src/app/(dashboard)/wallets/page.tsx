'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { formatDateTime, formatMoney } from '@/lib/format';
import {
  Badge, Button, Card, cx, ErrorState, PageHeader, Spinner,
} from '@/components/ui/primitives';
import { MoneyModeNotice } from '@/components/money-mode-notice';
import { Money, StatCard } from '@/components/domain';
import { AddExpenseModal, AddRevenueModal, TransferModal } from '@/components/financial-actions';
import {
  DeleteRecordDialog, EditRecordModal, RecordActions, type FieldSpec,
} from '@/components/record-actions';
import type { WalletBalance } from '@/types/database';

export default function WalletsPage() {
  const { t, locale } = useI18n();
  const [modal, setModal] = useState<'expense' | 'transfer' | 'revenue' | null>(null);
  const [editing, setEditing] = useState<WalletBalance | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const wallets = useSupabaseQuery<WalletBalance[]>(
    (sb) => sb.from('v_wallet_balances').select('*').order('sort_order'),
    [],
  );

  const students = useSupabaseQuery<Array<{ id: string; name: string }>>(
    (sb) => sb.from('students').select('id,name').order('name').limit(500),
    [],
  );

  const rows = wallets.data ?? [];
  const total = rows.filter((w) => w.is_active).reduce((s, w) => s + Number(w.balance ?? 0), 0);
  const reload = () => wallets.reload();

  if (wallets.error) return <ErrorState message={t.common.error} detail={wallets.error} />;

  const walletFields: FieldSpec[] = [
    { name: 'name', label: t.wallets.name, type: 'text', required: true },
    {
      name: 'type', label: t.wallets.type, type: 'select',
      options: [
        { value: 'bank', label: t.wallets.bank },
        { value: 'cash', label: t.wallets.cash },
        { value: 'digital', label: t.wallets.digital },
      ],
    },
    {
      name: 'opening_balance', label: t.wallets.openingBalance, type: 'number',
      hint: t.wallets.openingBalanceHint,
    },
    { name: 'sort_order', label: t.wallets.sortOrder, type: 'number' },
    { name: 'is_active', label: t.wallets.activeLabel, type: 'checkbox' },
  ];

  return (
    <>
      <PageHeader
        eyebrow={t.navGroups.money}
        title={t.wallets.title}
        subtitle={t.wallets.subtitle}
        action={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setModal('revenue')}>
              + {t.ledger.types.addManual}
            </Button>
            <Button variant="secondary" onClick={() => setModal('expense')}>
              + {t.ledger.types.expense}
            </Button>
            <Button variant="accent" onClick={() => setModal('transfer')}>
              {t.transfer.title}
            </Button>
          </div>
        }
      />

      <MoneyModeNotice />

      <section className="mb-4">
        <StatCard
          label={t.wallets.totalAcross}
          value={formatMoney(total, locale)}
          tone={total < 0 ? 'danger' : 'neutral'}
          emphasis
        />
      </section>

      {wallets.loading ? (
        <Spinner label={t.common.loading} />
      ) : (
        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((w) => {
            const balance = Number(w.balance ?? 0);
            return (
              <Card key={w.id} className={cx('p-5', !w.is_active && 'opacity-60')}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate font-display text-base font-semibold text-ink">
                      {w.name}
                    </h3>
                    <p className="mt-0.5 text-xs text-ink-faint">{t.wallets[w.type]}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {w.is_kashier_default && <Badge tone="accent">{t.wallets.kashierDefault}</Badge>}
                    {!w.is_active && <Badge>{t.wallets.inactive}</Badge>}
                  </div>
                </div>

                <p
                  className={cx(
                    'mt-4 font-display text-3xl font-semibold tnum',
                    balance < 0 ? 'text-danger' : 'text-ink',
                  )}
                >
                  {formatMoney(balance, locale)}
                </p>

                <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-3 text-xs">
                  <div>
                    <dt className="text-ink-faint">{t.wallets.moneyIn}</dt>
                    <dd className="mt-0.5"><Money value={Number(w.money_in ?? 0)} tone="ok" /></dd>
                  </div>
                  <div>
                    <dt className="text-ink-faint">{t.wallets.moneyOut}</dt>
                    <dd className="mt-0.5"><Money value={Number(w.money_out ?? 0)} tone="danger" /></dd>
                  </div>
                  <div>
                    <dt className="text-ink-faint">{t.wallets.openingBalance}</dt>
                    <dd className="mt-0.5 tnum text-ink-muted">
                      {formatMoney(Number(w.opening_balance ?? 0), locale)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink-faint">{t.wallets.lastMovement}</dt>
                    <dd className="mt-0.5 text-ink-muted">
                      {w.last_movement_at ? formatDateTime(w.last_movement_at, locale) : '—'}
                    </dd>
                  </div>
                </dl>

                <div className="mt-3 border-t border-border pt-3">
                  <RecordActions
                    onEdit={() => setEditing(w)}
                    onDelete={() => setDeleting(w.id)}
                  />
                </div>
              </Card>
            );
          })}
        </section>
      )}

      {editing && (
        <EditRecordModal
          open
          onClose={() => setEditing(null)}
          table="wallets"
          id={editing.id}
          fields={walletFields}
          values={editing as unknown as Record<string, unknown>}
          title={t.records.edit}
          onSaved={reload}
        />
      )}

      <DeleteRecordDialog
        kind="wallet"
        id={deleting}
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onDone={reload}
      />

      <AddExpenseModal
        open={modal === 'expense'} onClose={() => setModal(null)}
        wallets={rows} onSaved={reload}
      />
      <TransferModal
        open={modal === 'transfer'} onClose={() => setModal(null)}
        wallets={rows} onSaved={reload}
      />
      <AddRevenueModal
        open={modal === 'revenue'} onClose={() => setModal(null)}
        wallets={rows} onSaved={reload} students={students.data ?? []}
      />
    </>
  );
}
