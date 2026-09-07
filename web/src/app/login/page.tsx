'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useI18n } from '@/lib/i18n/context';
import { Button, Card, Field, Input } from '@/components/ui/primitives';

function LoginForm() {
  const { t, toggleLocale } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const denied = params.get('denied') === '1';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });

    if (authError) {
      // Never echo the gateway's message: it distinguishes "no such user" from
      // "wrong password" and turns the form into an account enumerator.
      setError(t.auth.invalid);
      setBusy(false);
      return;
    }

    const next = params.get('next');
    router.replace(next && next.startsWith('/') ? next : '/');
    router.refresh();
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{t.common.appName}</h1>
          <p className="mt-1 text-sm text-ink-muted">{t.auth.subtitle}</p>
        </div>

        <Card className="p-6">
          {denied && (
            <p className="mb-4 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">
              {t.auth.denied}
            </p>
          )}

          <form onSubmit={onSubmit} className="space-y-4">
            <Field label={t.auth.email}>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
                dir="ltr"
              />
            </Field>

            <Field label={t.auth.password}>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                dir="ltr"
              />
            </Field>

            {error && <p className="text-xs text-danger">{error}</p>}

            <Button type="submit" disabled={busy}>
              {busy ? t.auth.signingIn : t.auth.signIn}
            </Button>
          </form>
        </Card>

        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={toggleLocale}
            className="text-xs text-ink-muted underline underline-offset-4 hover:text-ink"
          >
            {t.common.language}
          </button>
        </div>
      </div>
    </main>
  );
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
