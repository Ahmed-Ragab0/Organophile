import { createClient } from '@/lib/supabase/server';
import { Shell } from '@/components/shell';

/**
 * Middleware already guarantees an authenticated admin reaches this layout.
 * The user is read again here only to show the signed-in email.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  return <Shell email={user?.email ?? null}>{children}</Shell>;
}
