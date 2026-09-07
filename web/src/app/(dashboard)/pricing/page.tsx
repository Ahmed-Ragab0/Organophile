'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { createClient } from '@/lib/supabase/client';
import { formatMoney, formatNumber } from '@/lib/format';
import {
  ActiveFilters, Badge, Card, CardHeader, Checkbox, Field, Input, PageHeader,
} from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/table';
import { Money, Mono, PaymentStatusBadge, StatCard } from '@/components/domain';
import { effectivePrice, PriceRules, PriceSourceBadge } from '@/components/pricing';
import type { Package, SubscriptionFinancials } from '@/types/database';

/** A subscription plus the names the financials view does not carry. */
type SubscriptionRow = {
  id: string;
  order_id: string;
  total_due: number | null;
  amount: number | null;
  installment_count: number;
  due_date: string | null;
  students: { id: string; name: string } | null;
  courses: { name: string } | null;
  packages: { name: string; price: number | null } | null;
};

type PackageRow = Package & { courses: { name: string } | null };

/**
 * Inline price editing.
 *
 * A price list where each change costs a modal is a price list nobody keeps
 * current. This commits on blur and on Enter, and says so by going quiet —
 * the value simply stays where you put it.
 */
function PriceCell({
  value, onSave,
}: { value: number | null; onSave: (next: number | null) => Promise<string | null> }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const committed = value === null ? '' : String(value);

  async function commit() {
    if (draft.trim() === committed) return;
    const next = draft.trim() === '' ? null : Number(draft);
    if (next !== null && (Number.isNaN(next) || next < 0)) {
      setDraft(committed);
      return;
    }
    setState('saving');
    const err = await onSave(next);
    if (err) {
      setState('error');
      setMessage(err);
      return;
    }
    setState('saved');
    setMessage(null);
    setTimeout(() => setState('idle'), 1400);
  }

  return (
    <div className="flex items-center justify-end gap-2">
      {state === 'saved' && <span className="text-xs text-ok">{t.common.saved}</span>}
      {state === 'error' && (
        <span className="max-w-40 truncate text-xs text-danger" title={message ?? ''}>
          {t.common.error}
        </span>
      )}
      {/*
        Width is set by this wrapper, not by a class on the input. The shared
        field style begins with `w-full`, and Tailwind resolves conflicting
        width utilities by their order in the stylesheet rather than in the
        class attribute — so `w-32` here silently lost. It only looked right
        while the column was narrow enough to hide it.
      */}
      <span className="block w-32 shrink-0">
        <Input
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          dir="ltr"
          value={draft}
          placeholder="—"
          disabled={state === 'saving'}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') setDraft(committed);
          }}
          className="py-1.5 text-end text-sm tnum"
        />
      </span>
    </div>
  );
}

export default function PricingPage() {
  const { t, locale } = useI18n();
  const [search, setSearch] = useState('');
  const [onlyUnpriced, setOnlyUnpriced] = useState(false);
  const [saveNonce, setSaveNonce] = useState(0);

  const reload = () => setSaveNonce((n) => n + 1);

  const packages = useSupabaseQuery<PackageRow[]>(
    (sb) =>
      sb.from('packages').select('*,courses(name)').order('name') as unknown as PromiseLike<{
        data: PackageRow[] | null;
        error: { message: string } | null;
      }>,
    [saveNonce],
  );

  const subscriptions = useSupabaseQuery<SubscriptionRow[]>(
    (sb) =>
      sb
        .from('subscriptions')
        .select(
          'id,order_id,total_due,amount,installment_count,due_date,' +
            'students(id,name),courses(name),packages(name,price)',
        )
        .order('created_at', { ascending: false })
        .limit(500) as unknown as PromiseLike<{
        data: SubscriptionRow[] | null;
        error: { message: string } | null;
      }>,
    [saveNonce],
  );

  // Fetched deeper than the subscription list it is joined against, so a
  // subscription can never land in the table with its money missing.
  const financials = useSupabaseQuery<SubscriptionFinancials[]>(
    (sb) => sb.from('v_subscription_financials').select('*').limit(1000),
    [saveNonce],
  );

  const byId = new Map((financials.data ?? []).map((f) => [f.subscription_id, f]));

  const query = search.trim().toLowerCase();

  /*
   * One search over both tables.
   *
   * The box sits above both, and a control positioned over two tables that
   * only filters one is a control that lies about its scope. "Needs a price"
   * means the same thing in each — a package with no price, a subscription
   * with nothing to fall back on — so the pair reads as a single question:
   * show me everything that still needs pricing.
   */
  const packageRows = (packages.data ?? []).filter((p) => {
    if (query
      && !p.name.toLowerCase().includes(query)
      && !(p.courses?.name ?? '').toLowerCase().includes(query)) return false;
    if (onlyUnpriced && p.price !== null) return false;
    return true;
  });

  const rows = (subscriptions.data ?? [])
    .map((s) => ({ ...s, money: byId.get(s.id) ?? null }))
    .filter((s) => {
      if (query
        && !s.order_id.toLowerCase().includes(query)
        && !(s.students?.name ?? '').toLowerCase().includes(query)
        && !(s.courses?.name ?? '').toLowerCase().includes(query)
        && !(s.packages?.name ?? '').toLowerCase().includes(query)) return false;
      if (onlyUnpriced && effectivePrice(s).source !== 'none') return false;
      return true;
    });

  /** Packages with no price of their own — the step-1 half of the work. */
  const unpricedPackages = (packages.data ?? []).filter((p) => p.price === null).length;

  const totals = rows.reduce(
    (acc, r) => ({
      billed: acc.billed + Number(r.money?.total_due ?? 0),
      paid: acc.paid + Number(r.money?.total_paid ?? 0),
      remaining: acc.remaining + Number(r.money?.remaining ?? 0),
      unpriced: acc.unpriced + (effectivePrice(r).source === 'none' ? 1 : 0),
    }),
    { billed: 0, paid: 0, remaining: 0, unpriced: 0 },
  );

  async function savePackagePrice(id: string, price: number | null): Promise<string | null> {
    const { error } = await createClient().from('packages').update({ price }).eq('id', id);
    if (error) return error.message;
    reload();
    return null;
  }

  async function saveSubscriptionPrice(id: string, total_due: number | null): Promise<string | null> {
    const { error } = await createClient().from('subscriptions').update({ total_due }).eq('id', id);
    if (error) return error.message;
    reload();
    return null;
  }

  // At full width the course earns its own column rather than sitting as
  // sub-text, and the status is worth stating outright: a null price is the
  // whole reason this table exists, and an empty cell is easy to skim past.
  const packageColumns: Array<Column<PackageRow>> = [
    {
      key: 'name',
      header: t.subscriptions.package,
      render: (p) => <p className="truncate font-medium text-ink">{p.name}</p>,
    },
    {
      key: 'course',
      header: t.subscriptions.course,
      render: (p) =>
        p.courses?.name ?? <span className="text-ink-faint">—</span>,
    },
    {
      key: 'status',
      header: t.studentDetail.status,
      render: (p) =>
        p.price === null
          ? <Badge tone="danger">{t.pricing.sourceNone}</Badge>
          : <Badge tone="ok">{t.pricing.priced}</Badge>,
    },
    {
      key: 'uses',
      header: t.pricing.subscriptionsUsing,
      numeric: true,
      render: (p) => {
        const n = (subscriptions.data ?? []).filter((s) => s.packages?.name === p.name).length;
        return n === 0
          ? <span className="text-ink-faint">—</span>
          : <span className="tnum text-ink-muted">{formatNumber(n, locale)}</span>;
      },
    },
    {
      key: 'price',
      header: t.pricing.price,
      numeric: true,
      render: (p) => (
        <PriceCell value={p.price} onSave={(next) => savePackagePrice(p.id, next)} />
      ),
    },
  ];

  type Row = (typeof rows)[number];

  const columns: Array<Column<Row>> = [
    {
      key: 'order',
      header: t.subscriptions.orderId,
      render: (r) => (
        <Link href={`/pricing/${r.id}`} className="block min-w-0">
          <Mono value={r.order_id} />
          <p className="truncate text-xs text-ink-muted">
            {r.students?.name ?? <span className="text-ink-faint">{t.pricing.noStudent}</span>}
          </p>
        </Link>
      ),
    },
    {
      key: 'course',
      header: t.subscriptions.course,
      render: (r) => (
        <div className="min-w-0">
          <p className="truncate text-ink">{r.courses?.name ?? '—'}</p>
          {r.packages?.name && <p className="truncate text-xs text-ink-faint">{r.packages.name}</p>}
        </div>
      ),
    },
    {
      key: 'source',
      header: t.pricing.priceSource,
      render: (r) => <PriceSourceBadge source={effectivePrice(r).source} />,
    },
    {
      key: 'price',
      header: t.pricing.totalDue,
      numeric: true,
      render: (r) => (
        <PriceCell value={r.total_due} onSave={(next) => saveSubscriptionPrice(r.id, next)} />
      ),
    },
    {
      key: 'paid',
      header: t.studentDetail.totalPaid,
      numeric: true,
      render: (r) => <Money value={Number(r.money?.total_paid ?? 0)} tone="ok" />,
    },
    {
      key: 'remaining',
      header: t.studentDetail.remaining,
      numeric: true,
      render: (r) => (
        <Money
          value={Number(r.money?.remaining ?? 0)}
          tone={Number(r.money?.remaining ?? 0) > 0 ? 'danger' : 'plain'}
        />
      ),
    },
    {
      key: 'installments',
      header: t.pricing.installmentCount,
      numeric: true,
      render: (r) => <span className="tnum text-ink-muted">{r.installment_count}</span>,
    },
    {
      key: 'status',
      header: t.studentDetail.status,
      render: (r) => <PaymentStatusBadge status={r.money?.payment_status} />,
    },
    {
      key: 'edit',
      header: '',
      render: (r) => (
        <Link
          href={`/pricing/${r.id}`}
          className="text-xs font-medium text-accent-strong hover:underline"
        >
          {t.pricing.openEditor} →
        </Link>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow={t.navGroups.people}
        title={t.pricing.title}
        subtitle={t.pricing.subtitle}
      />

      <PriceRules />

      <section className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label={t.pricing.billedTotal} value={formatMoney(totals.billed, locale)} />
        <StatCard
          label={t.pricing.collectedTotal}
          value={formatMoney(totals.paid, locale)}
          tone="ok"
        />
        <StatCard
          label={t.pricing.outstandingTotal}
          value={formatMoney(totals.remaining, locale)}
          tone={totals.remaining > 0 ? 'warn' : 'neutral'}
          emphasis
        />
        {/*
          The only tile that is a task rather than a figure, so it is the only
          one you can press: it filters the table to exactly the rows it is
          counting. Reading "3 unpriced" and then hunting for which three is
          work the page can do itself.
        */}
        <button
          type="button"
          onClick={() => setOnlyUnpriced((v) => !v)}
          aria-pressed={onlyUnpriced}
          disabled={totals.unpriced === 0 && !onlyUnpriced}
          className="rounded-card text-start transition-transform duration-150 ease-soft enabled:hover:-translate-y-px disabled:cursor-default"
        >
          <StatCard
            label={t.pricing.unpricedCount}
            value={String(totals.unpriced)}
            tone={totals.unpriced > 0 ? 'danger' : 'neutral'}
            hint={
              totals.unpriced > 0
                ? (onlyUnpriced ? t.pricing.showingUnpriced : t.pricing.showUnpriced)
                : t.pricing.allPriced
            }
          />
        </button>
      </section>

      {/*
        One search, then the two steps stacked in the order the work is done.
        Side by side, the panels read as two unrelated tools competing for the
        same screen, and the narrow one squeezed a table that has real columns
        into a sliver. Stacked, each gets the full width it needs and the
        reading order carries the meaning: search, then price the package,
        then handle the orders that differ.
      */}
      <Card className="mb-5">
        <div className="grid items-end gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto]">
          <Field label={t.common.search} hint={t.pricing.searchHint}>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="YOK-… / أحمد / كيمياء"
            />
          </Field>
          <div className="flex items-center gap-3 pb-1">
            <Checkbox
              checked={onlyUnpriced}
              onChange={setOnlyUnpriced}
              label={t.pricing.onlyUnpriced}
            />
          </div>
        </div>

        <ActiveFilters
          label={t.subscriptions.activeFilters}
          clearAllLabel={t.subscriptions.clearFilters}
          onClear={() => { setSearch(''); setOnlyUnpriced(false); }}
          filters={[
            search.trim() && {
              key: 'search', label: t.common.search, value: search.trim(),
              onRemove: () => setSearch(''),
            },
            onlyUnpriced && {
              key: 'unpriced', label: t.pricing.priceSource,
              value: t.pricing.sourceNone,
              onRemove: () => setOnlyUnpriced(false),
            },
          ].filter(Boolean) as Array<{
            key: string; label: string; value: string; onRemove: () => void;
          }>}
        />
      </Card>

      <div className="space-y-5">
        <Card>
          <CardHeader
            title={t.pricing.packagePrices}
            hint={t.pricing.packagePricesHint}
            action={
              <div className="flex items-center gap-2">
                {unpricedPackages > 0 && (
                  <Badge tone="danger">
                    {`${formatNumber(unpricedPackages, locale)} ${t.pricing.sourceNone}`}
                  </Badge>
                )}
                <Badge tone="brand">{t.pricing.stepOne}</Badge>
              </div>
            }
          />
          <DataTable
            columns={packageColumns}
            rows={packageRows}
            keyOf={(p) => p.id}
            loading={packages.loading}
            error={packages.error}
            emptyMessage={
              search.trim() || onlyUnpriced
                ? t.subscriptions.noMatches
                : t.pricing.noPackages
            }
            loadingMessage={t.common.loading}
            errorMessage={t.common.error}
            loadingRows={4}
          />
        </Card>

        <Card>
          <CardHeader
            title={t.pricing.subscriptionPrices}
            hint={`${formatNumber(rows.length, locale)} ${t.common.rows}`}
            action={<Badge tone="brand">{t.pricing.stepTwo}</Badge>}
          />
          <DataTable
            columns={columns}
            rows={rows}
            keyOf={(r) => r.id}
            loading={subscriptions.loading || financials.loading}
            error={subscriptions.error ?? financials.error}
            emptyMessage={
              search.trim() || onlyUnpriced ? t.subscriptions.noMatches : t.common.empty
            }
            loadingMessage={t.common.loading}
            errorMessage={t.common.error}
          />
        </Card>
      </div>

    </>
  );
}
