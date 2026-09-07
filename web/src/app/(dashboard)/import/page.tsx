'use client';

import { useRef, useState } from 'react';
import Papa from 'papaparse';
import { useI18n } from '@/lib/i18n/context';
import { createClient } from '@/lib/supabase/client';
import { Button, Card, CardHeader, Field, PageHeader, Select } from '@/components/ui/primitives';
import { StatCard } from '@/components/domain';
import {
  applyMapping, guessStudentMapping, guessTransactionMapping,
  STUDENT_FIELDS, TRANSACTION_FIELDS,
  type StudentField, type TransactionField,
} from '@/lib/import-mapping';

type Kind = 'students' | 'transactions';
type Row = Record<string, unknown>;

type ImportResult = {
  inserted?: number; updated?: number; skipped?: number;
  matched?: number; missing?: number; mismatched?: number;
  errors?: unknown[]; issues?: unknown[];
};

const MAX_ROWS = 10000;

export default function ImportPage() {
  const { t } = useI18n();
  const fileInput = useRef<HTMLInputElement>(null);

  const [kind, setKind] = useState<Kind>('students');
  const [reconcileMode, setReconcileMode] = useState<'live' | 'test'>('live');
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fields: string[] = kind === 'students' ? STUDENT_FIELDS : TRANSACTION_FIELDS;

  function onFile(file: File) {
    setError(null);
    setResult(null);
    setFileName(file.name);

    Papa.parse<Row>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      // ukkera exports are UTF-8; being explicit avoids a locale-dependent guess
      // that would mangle Arabic names.
      encoding: 'utf-8',
      complete: (parsed) => {
        const cols = (parsed.meta.fields ?? []).filter(Boolean);
        const data = parsed.data.slice(0, MAX_ROWS);
        setHeaders(cols);
        setRows(data);
        setMapping(
          kind === 'students'
            ? guessStudentMapping(cols)
            : guessTransactionMapping(cols),
        );
        if (parsed.errors.length > 0) {
          setError(`${parsed.errors[0].message} (row ${parsed.errors[0].row ?? '?'})`);
        }
      },
      error: (err) => setError(err.message),
    });
  }

  function changeKind(next: Kind) {
    setKind(next);
    setResult(null);
    // Re-guess against the already-loaded headers so switching type does not
    // force the operator to re-pick the file.
    if (headers.length > 0) {
      setMapping(next === 'students' ? guessStudentMapping(headers) : guessTransactionMapping(headers));
    }
  }

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);

    const supabase = createClient();

    if (kind === 'students') {
      const payload = applyMapping(rows, mapping as Record<StudentField, string>);
      const { data, error: rpcError } = await supabase.rpc('import_students', { p_rows: payload });
      setBusy(false);
      if (rpcError) { setError(rpcError.message); return; }
      setResult(data as ImportResult);
    } else {
      const payload = applyMapping(rows, mapping as Record<TransactionField, string>);
      const { data, error: rpcError } = await supabase.rpc('reconcile_transactions', {
        p_rows: payload,
        p_mode: reconcileMode,
      });
      setBusy(false);
      if (rpcError) { setError(rpcError.message); return; }
      setResult(data as ImportResult);
    }
  }

  const mappedPreview = rows.length > 0
    ? applyMapping(rows.slice(0, 5), mapping as Record<string, string>)
    : [];

  const activeFields = fields.filter((f) => mapping[f]);

  return (
    <>
      <PageHeader eyebrow={t.navGroups.ops} title={t.importPage.title} subtitle={t.importPage.subtitle} />

      <Card className="mb-4">
        <CardHeader title={t.importPage.kind} />
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <Field label={t.importPage.kind}>
            <Select value={kind} onChange={(e) => changeKind(e.target.value as Kind)}>
              <option value="students">{t.importPage.students}</option>
              <option value="transactions">{t.importPage.transactions}</option>
            </Select>
          </Field>

          <div className="flex items-end">
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.tsv,text/csv,text/tab-separated-values"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
              }}
            />
            <Button variant="secondary" onClick={() => fileInput.current?.click()}>
              {fileName || t.importPage.dropHint}
            </Button>
          </div>
        </div>

        {kind === 'transactions' && (
          <div className="border-t border-border px-4 py-3">
            <div className="max-w-xs">
              <Field label={t.common.mode}>
                <Select
                  value={reconcileMode}
                  onChange={(e) => setReconcileMode(e.target.value as 'live' | 'test')}
                >
                  <option value="live">{t.common.live}</option>
                  <option value="test">{t.common.test}</option>
                </Select>
              </Field>
            </div>
            <p className="mt-2 text-xs text-ink-muted">{t.reconciliation.unmatchedHint}</p>
          </div>
        )}
      </Card>

      {headers.length > 0 && (
        <Card className="mb-4">
          <CardHeader
            title={t.importPage.mapping}
            hint={`${rows.length} ${t.importPage.rowsFound}`}
          />
          <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
            {fields.map((field) => (
              <Field key={field} label={field}>
                <Select
                  value={mapping[field] ?? ''}
                  onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value }))}
                >
                  <option value="">{t.importPage.ignore}</option>
                  {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </Select>
              </Field>
            ))}
          </div>

          {mappedPreview.length > 0 && activeFields.length > 0 && (
            <div className="overflow-x-auto border-t border-border">
              <table className="w-full min-w-max text-sm">
                <thead>
                  <tr className="border-b border-border">
                    {activeFields.map((f) => (
                      <th key={f} className="px-4 py-2 text-start text-xs font-semibold text-ink-muted">{f}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {mappedPreview.map((row, i) => (
                    <tr key={i} className="border-b border-border/60 last:border-0">
                      {activeFields.map((f) => (
                        <td key={f} className="px-4 py-2 text-ink-muted">{String(row[f] ?? '')}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="border-t border-border p-4">
            <Button onClick={run} disabled={busy || activeFields.length === 0}>
              {busy ? t.common.loading : t.importPage.runImport}
            </Button>
          </div>
        </Card>
      )}

      {error && (
        <Card className="mb-4">
          <p className="p-4 text-sm text-danger">{error}</p>
        </Card>
      )}

      {result && (
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {kind === 'students' ? (
            <>
              <StatCard label={t.importPage.resultInserted} value={result.inserted ?? 0} tone="ok" />
              <StatCard label={t.importPage.resultUpdated} value={result.updated ?? 0} />
              <StatCard
                label={t.importPage.resultSkipped}
                value={result.skipped ?? 0}
                tone={(result.skipped ?? 0) > 0 ? 'warn' : 'neutral'}
              />
              <StatCard
                label={t.importPage.resultFailed}
                value={result.errors?.length ?? 0}
                tone={(result.errors?.length ?? 0) > 0 ? 'danger' : 'ok'}
              />
            </>
          ) : (
            <>
              <StatCard label={t.reconciliation.linked} value={result.matched ?? 0} tone="ok" />
              <StatCard
                label={t.reconciliation.unpaidTitle}
                value={result.missing ?? 0}
                tone={(result.missing ?? 0) > 0 ? 'warn' : 'neutral'}
              />
              <StatCard
                label={t.importPage.resultFailed}
                value={result.mismatched ?? 0}
                tone={(result.mismatched ?? 0) > 0 ? 'danger' : 'ok'}
              />
            </>
          )}
        </section>
      )}

      {result && (result.errors?.length || result.issues?.length) ? (
        <Card className="mt-4">
          <CardHeader title={t.common.error} />
          <pre className="ltr-id overflow-x-auto p-4 text-xs text-ink-muted">
            {JSON.stringify(result.errors?.length ? result.errors : result.issues, null, 2)}
          </pre>
        </Card>
      ) : null}
    </>
  );
}
