import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { Shell } from '@/components/shell';
import { AccessProvider, NO_ACCESS, type Access } from '@/lib/access/context';

/**
 * Middleware already guarantees a signed-in staff member reaches this layout.
 * What is read here is what they may DO, because the sidebar and every page
 * below need it before the first paint — a nav that renders in full and then
 * loses half its links reads as a bug.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data } = await supabase.rpc('my_access');
  const access = (data as Access | null) ?? NO_ACCESS;

  // Belt and braces with the middleware. If the row was revoked between the
  // two checks, this is the one that catches it.
  if (!access.is_staff) redirect('/login?denied=1');

  return (
    <AccessProvider access={access}>
      <Shell email={access.email ?? user?.email ?? null}>{children}</Shell>
    </AccessProvider>
  );
}
