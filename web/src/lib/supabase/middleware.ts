import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { firstAllowedPath, permissionForPath } from '@/lib/access/routes';

const PUBLIC_PATHS = ['/login', '/auth'];

/**
 * Refreshes the auth session on every request and gates the app.
 *
 * Three checks, in order:
 *   1. Is there a valid Supabase session?     -> otherwise /login
 *   2. Is that user on the staff list?        -> otherwise /login?denied=1
 *   3. Do they hold this page's permission?   -> otherwise their first page
 *
 * None of this is the real boundary: RLS refuses the same rows whatever the
 * router does. It exists so that someone who cannot use a screen never has to
 * look at an empty one — and so the third case lands them somewhere they CAN
 * use rather than on a dead end.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // getUser() revalidates against Auth. Never trust getSession() for a gate —
  // it only reads the cookie, which the client controls.
  const { data: { user } } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path.startsWith(p));

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', path);
    return NextResponse.redirect(url);
  }

  if (user) {
    // One round trip answers both questions. `my_access` takes no argument and
    // reports only on the caller, so it cannot be aimed at anyone else.
    const { data } = await supabase.rpc('my_access');
    const access = (data ?? null) as
      { is_staff?: boolean; permissions?: string[] } | null;
    const permissions = access?.is_staff ? (access.permissions ?? []) : [];
    const landing = firstAllowedPath(permissions);

    if (path === '/login') {
      /*
       * Signed in, so the login page has nothing to offer — unless there is
       * nowhere to send them. A staff row whose role holds nothing would
       * otherwise bounce between /login and the first gated page forever, so
       * that case stays here and reads the denial message.
       */
      if (landing === null) return response;
      const url = request.nextUrl.clone();
      url.pathname = landing;
      url.search = '';
      return NextResponse.redirect(url);
    }

    if (!isPublic) {
      if (!access?.is_staff || landing === null) {
        const url = request.nextUrl.clone();
        url.pathname = '/login';
        url.searchParams.set('denied', '1');
        return NextResponse.redirect(url);
      }

      const needed = permissionForPath(path);
      if (needed && !permissions.includes(needed)) {
        const url = request.nextUrl.clone();
        // Somewhere they can actually use. A dead end would be worse, and
        // sending them to /login would be a loop for anyone whose role does
        // not happen to include the overview.
        url.pathname = landing;
        url.search = '';
        return NextResponse.redirect(url);
      }
    }
  }

  return response;
}
