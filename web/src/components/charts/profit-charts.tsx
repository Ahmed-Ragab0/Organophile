'use client';

import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Legend,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useI18n } from '@/lib/i18n/context';
import { formatMoney, formatShortDay } from '@/lib/format';
import { EmptyState } from '../ui/primitives';
import type { FinanceDaily } from '@/types/database';

/**
 * Charts are always LTR regardless of page direction: Recharts positions axes
 * and tooltips in document coordinates, and an RTL container flips the plot
 * away from its own axis labels.
 */
function ChartFrame({ children }: { children: React.ReactNode }) {
  return (
    <div dir="ltr" className="h-64 w-full px-2 pb-2">
      {children}
    </div>
  );
}

const AXIS = { stroke: 'var(--color-ink-faint)', fontSize: 11 };

export function RevenueExpensesChart({ rows }: { rows: FinanceDaily[] }) {
  const { t, locale } = useI18n();
  if (rows.length === 0) return <EmptyState message={t.charts.noData} />;

  const data = rows.map((r) => ({
    day: formatShortDay(r.day, locale),
    revenue: Number(r.revenue ?? 0),
    expenses: Number(r.expenses ?? 0),
  }));

  return (
    <ChartFrame>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
          <XAxis dataKey="day" tick={AXIS} tickLine={false} axisLine={false} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} width={70} />
          <Tooltip
            contentStyle={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 10,
              fontSize: 12,
              color: 'var(--color-ink)',
            }}
            formatter={(value) => formatMoney(Number(value ?? 0), locale)}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="revenue" name={t.charts.revenue} fill="var(--color-ok)" radius={[4, 4, 0, 0]} />
          <Bar dataKey="expenses" name={t.charts.expenses} fill="var(--color-danger)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export function NetProfitChart({ rows }: { rows: FinanceDaily[] }) {
  const { t, locale } = useI18n();
  if (rows.length === 0) return <EmptyState message={t.charts.noData} />;

  const data = rows.map((r) => ({
    day: formatShortDay(r.day, locale),
    net: Number(r.net_profit ?? 0),
  }));

  return (
    <ChartFrame>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <defs>
            <linearGradient id="netFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
          <XAxis dataKey="day" tick={AXIS} tickLine={false} axisLine={false} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} width={70} />
          <Tooltip
            contentStyle={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 10,
              fontSize: 12,
              color: 'var(--color-ink)',
            }}
            formatter={(value) => formatMoney(Number(value ?? 0), locale)}
          />
          <Area
            type="monotone"
            dataKey="net"
            name={t.charts.netProfit}
            stroke="var(--color-accent)"
            strokeWidth={2}
            fill="url(#netFill)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
