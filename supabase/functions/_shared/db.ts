/**
 * Service-role Supabase client for the webhook endpoints.
 *
 * The service role bypasses RLS, which is exactly what ingestion needs and
 * exactly why this key must never reach the browser. It is read from the
 * function's own environment and used only to call the three locked-down
 * ingest wrappers in the public schema.
 */
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { requiredEnv } from './env.ts';

let cached: SupabaseClient | null = null;

export function serviceClient(): SupabaseClient {
  if (cached) return cached;
  cached = createClient(
    requiredEnv('SUPABASE_URL'),
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  return cached;
}

/** Best-effort audit of a delivery we refused. Never throws into the caller. */
export async function recordRejection(params: {
  endpoint: string;
  reason: string;
  detail?: string | null;
  bodySha256?: string | null;
  bodyExcerpt?: string | null;
}): Promise<void> {
  try {
    await serviceClient().rpc('record_webhook_rejection', {
      p_endpoint: params.endpoint,
      p_reason: params.reason,
      p_detail: params.detail ?? null,
      p_body_sha256: params.bodySha256 ?? null,
      p_body_excerpt: params.bodyExcerpt ?? null,
    });
  } catch (err) {
    console.error(
      JSON.stringify({ level: 'error', event: 'rejection_audit_failed', message: String(err) }),
    );
  }
}
