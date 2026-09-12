'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { useAccess } from '@/lib/access/context';
import { useSupabaseQuery } from '@/lib/use-query';
import { useMode } from '@/lib/mode/context';
import { createClient } from '@/lib/supabase/client';
import { formatDateTime } from '@/lib/format';
import { Badge, Button, Card, CardHeader, PageHeader } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/table';
import { Mono } from '@/components/domain';
import type {
  ClientAccessAudit, FailedEvent, IngestHealth, WebhookRejection,
} from '@/types/database';

type StateKey = 'pending' | 'processed' | 'failed' | 'ignored';

export default function HealthPage() {
  const { t, locale } = useI18n();
  const { can } = useAccess();
  const mayWrite = can('system.write');
  const { mode } = useMode();
  const [sweeping, setSweeping] = useState(false);
  const [sweepResult, setSweepResult] = useState<string | null>(null);

  const health = useSupabaseQuery<IngestHealth[]>(
    (sb) => sb.from('v_ingest_health').select('*'),
    [],
  );

  /* Both pipelines. ukkera's raw events carry no mode — a failed delivery
     there is a stranded purchase whichever side of the toggle you are on — so
     they are never filtered out by it. */
  const failed = useSupabaseQuery<FailedEvent[]>(
    (sb) =>
      sb.from('v_failed_events').select('*').or(`mode.eq.${mode},mode.is.null`)
        .order('received_at', { ascending: false }).limit(50),
    [sweepResult, mode],
  );

  // 0037 revoked TRUNCATE from the browser client, which RLS cannot govern.
  // The revoke is easy; noticing it come back is the hard part, so the check
  // lives on the screen rather than in a memory.
  const access = useSupabaseQuery<ClientAccessAudit[]>(
    (sb) => sb.from('v_client_access_audit').select('*'),
    [],
  );

  const rejections = useSupabaseQuery<WebhookRejection[]>(
    (sb) => sb.from('webhook_rejections').select('*').order('received_at', { ascending: false }).limit(50),
    [],
  );

  async function sweep() {
    setSweeping(true);
    const { data, error } = await createClient().rpc('sweep_failed_events');
    setSweeping(false);
    setSweepResult(error ? error.message : JSON.stringify(data));
    health.reload();
  }

  const accessCols: Array<Column<ClientAccessAudit>> = [
    { key: 'object', header: t.health.accessObject, render: (r) => <Mono value={r.object} /> },
    { key: 'grantee', header: t.health.accessGrantee, render: (r) => <Mono value={r.grantee} /> },
    {
      key: 'finding', header: t.health.accessFinding,
      render: (r) => <Badge tone="danger">{r.finding}</Badge>,
    },
  ];

  const healthCols: Array<Column<IngestHealth>> = [
    { key: 'pipeline', header: t.health.pipeline, render: (r) => <span className="font-medium text-ink">{r.pipeline}</span> },
    {
      key: 'state',
      header: t.health.state,
      render: (r) => {
        const key = (r.state ?? 'pending') as StateKey;
        const tone = key === 'processed' ? 'ok' : key === 'failed' ? 'danger' : key === 'ignored' ? 'neutral' : 'warn';
        return <Badge tone={tone}>{t.health.stateNames[key] ?? key}</Badge>;
      },
    },
    { key: 'events', header: t.health.events, numeric: true, render: (r) => r.events ?? 0 },
    { key: 'dupes', header: t.health.duplicates, numeric: true, render: (r) => r.duplicates ?? 0 },
    { key: 'latest', header: t.health.latest, render: (r) => <span className="text-xs text-ink-muted">{formatDateTime(r.latest_at, locale)}</span> },
  ];

  const failedCols: Array<Column<FailedEvent>> = [
    { key: 'received', header: t.health.latest, render: (r) => <span className="text-xs text-ink-muted">{formatDateTime(r.received_at, locale)}</span> },
    { key: 'pipeline', header: t.health.pipeline, render: (r) => <span className="font-medium text-ink">{r.pipeline}</span> },
    { key: 'event', header: t.payments.event, render: (r) => <Mono value={r.event} /> },
    // Whose purchase it was. An error with no subject is a line nobody chases.
    { key: 'subject', header: '', render: (r) => <span className="text-xs text-ink-muted">{r.subject}</span> },
    { key: 'attempts', header: '#', numeric: true, render: (r) => r.process_attempts },
    { key: 'error', header: t.common.error, render: (r) => <span className="text-xs text-danger">{r.process_error}</span> },
  ];

  const rejectionCols: Array<Column<WebhookRejection>> = [
    { key: 'received', header: t.health.latest, render: (r) => <span className="text-xs text-ink-muted">{formatDateTime(r.received_at, locale)}</span> },
    { key: 'endpoint', header: t.health.endpoint, render: (r) => <Mono value={r.endpoint} /> },
    { key: 'reason', header: t.health.reason, render: (r) => <Badge tone="danger">{r.reason}</Badge> },
    { key: 'detail', header: '', render: (r) => <span className="text-xs text-ink-faint">{r.detail}</span> },
  ];

  return (
    <>
      <PageHeader
        eyebrow={t.navGroups.ops}
        title={t.health.title}
        subtitle={t.health.subtitle}
        action={
          <Button variant="secondary" onClick={sweep} disabled={sweeping || !mayWrite}>
            {sweeping ? t.common.loading : t.health.sweep}
          </Button>
        }
      />

      {sweepResult && (
        <p className="mb-4 rounded-lg bg-info-soft px-3 py-2 text-xs text-info">
          {t.health.swept}: <span className="ltr-id">{sweepResult}</span>
        </p>
      )}

      <Card className="mb-4">
        <CardHeader
          title={t.health.access}
          hint={t.health.accessHint}
          action={
            <Badge tone={(access.data ?? []).length === 0 ? 'ok' : 'danger'}>
              {(access.data ?? []).length === 0
                ? t.common.yes
                : String((access.data ?? []).length)}
            </Badge>
          }
        />
        <DataTable
          columns={accessCols}
          rows={access.data ?? []}
          keyOf={(r, i) => `${r.object}-${r.grantee}-${r.finding}-${i}`}
          loading={access.loading}
          error={access.error}
          emptyMessage={t.health.accessClean}
          loadingMessage={t.common.loading}
          errorMessage={t.common.error}
        />
      </Card>

      <Card className="mb-4">
        <CardHeader title={t.health.subtitle} />
        <DataTable
          columns={healthCols}
          rows={health.data ?? []}
          keyOf={(r, i) => `${r.pipeline}-${r.state}-${i}`}
          loading={health.loading}
          error={health.error}
          emptyMessage={t.common.empty}
          loadingMessage={t.common.loading}
          errorMessage={t.common.error}
        />
      </Card>

      <Card className="mb-4">
        <CardHeader title={t.health.stateNames.failed} hint={t.health.sweep} />
        <DataTable
          columns={failedCols}
          rows={failed.data ?? []}
          keyOf={(r) => r.id}
          loading={failed.loading}
          error={failed.error}
          emptyMessage={t.common.empty}
          loadingMessage={t.common.loading}
          errorMessage={t.common.error}
        />
      </Card>

      <Card>
        <CardHeader title={t.health.rejections} />
        <DataTable
          columns={rejectionCols}
          rows={rejections.data ?? []}
          keyOf={(r) => r.id}
          loading={rejections.loading}
          error={rejections.error}
          emptyMessage={t.common.empty}
          loadingMessage={t.common.loading}
          errorMessage={t.common.error}
        />
      </Card>
    </>
  );
}
