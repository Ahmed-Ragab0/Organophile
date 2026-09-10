'use client';

import Image from 'next/image';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useI18n } from '@/lib/i18n/context';
import { Button, Field, Input, MoleculeField, Notice } from '@/components/ui/primitives';

/**
 * The brand half.
 *
 * The photograph is the product's actual face — the person whose students and
 * money this console tracks — so it carries the panel rather than an abstract
 * gradient. The violet scrim pulls the image into the palette, and the benzene
 * lattice above it is the subject's own diagram: organic chemistry, drawn the
 * way a chemist draws it.
 */
function BrandPanel() {
  const { t } = useI18n();

  return (
    <div className="relative hidden overflow-hidden bg-brand-strong lg:block">
      {/* Scaled past `cover` so the watermark baked into the bottom of the
          photograph is cropped out of frame rather than dimmed by the scrim. */}
      <Image
        src="/pc.jpg"
        alt=""
        fill
        priority
        sizes="50vw"
        className="scale-110 object-cover object-top"
      />

      {/* Two scrims. The vertical one carries the copy: it has to be close to
          opaque by the bottom edge, both for contrast under the headline and
          to swallow the watermark baked into the photograph. */}
      <div
        aria-hidden
        className="absolute inset-0 bg-gradient-to-b from-[#3f1e6b]/50 via-[#2a1345]/45 via-50% to-[#140a21] to-88%"
      />
      <div aria-hidden className="absolute inset-0 mix-blend-soft-light">
        <MoleculeField className="h-full w-full text-white/45" />
      </div>

      <div className="relative flex h-full flex-col justify-between p-10 xl:p-12">
        <Image
          src="/logo-lockup.png"
          alt={t.common.appName}
          width={818}
          height={748}
          priority
          className="h-28 w-auto object-contain object-start drop-shadow-lg"
        />

        <div className="max-w-md">
          <p className="font-display text-3xl leading-[1.35] font-semibold text-white display-tight xl:text-[2.125rem]">
            {t.auth.panelHeadline}
          </p>
          <p className="mt-4 text-sm leading-relaxed text-white/70">{t.auth.panelBody}</p>

          <div className="mt-8 flex flex-wrap gap-2">
            {[t.nav.students, t.nav.courses, t.nav.subscriptions, t.nav.reports].map((label) => (
              <span
                key={label}
                className="rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-medium text-white/85 backdrop-blur-sm"
              >
                {label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function LoginForm() {
  const { t, toggleLocale } = useI18n();
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
    /*
     * A full document load, for the same reason sign-out does one: the
     * dashboard layout reads who you are on the SERVER and hands it down, and
     * the client router can serve that layout from cache. Signing in as a
     * second person in the same tab would otherwise render the first person's
     * screen over the second person's session.
     *
     * `next` is checked to start with "/" before it is followed, so a crafted
     * `?next=https://elsewhere` cannot turn the login form into a redirector.
     */
    window.location.replace(next && next.startsWith('/') ? next : '/');
  }

  return (
    <div className="flex min-h-dvh flex-col justify-center px-6 py-12 sm:px-10">
      <div className="mx-auto w-full max-w-sm">
        {/* On a phone the brand panel is gone, so the mark comes back here. */}
        <div className="mb-9 lg:mb-10">
          <span
            aria-hidden
            className="brand-ramp mb-5 flex h-12 w-12 items-center justify-center rounded-tile shadow-raised lg:hidden"
          >
            <Image src="/logo-mark.png" alt="" width={96} height={96} className="h-[70%] w-[70%] object-contain" />
          </span>
          <h1 className="font-display text-2xl font-semibold text-ink display-tight">
            {t.auth.title}
          </h1>
          <p className="mt-1.5 text-sm text-ink-muted">{t.auth.subtitle}</p>
        </div>

        {denied && (
          <div className="mb-5">
            <Notice tone="danger">{t.auth.denied}</Notice>
          </div>
        )}

        <form onSubmit={onSubmit} className="space-y-5">
          <Field label={t.auth.email}>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              placeholder="name@example.com"
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

          {error && <Notice tone="danger">{error}</Notice>}

          <Button type="submit" size="lg" disabled={busy} className="w-full">
            {busy ? t.auth.signingIn : t.auth.signIn}
          </Button>
        </form>

        <div className="mt-8 flex items-center justify-between border-t border-border pt-5">
          <p className="text-xs text-ink-faint">{t.auth.adminOnly}</p>
          <button
            type="button"
            onClick={toggleLocale}
            className="rounded-chip px-2 py-1 text-xs font-medium text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            {t.common.language}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <BrandPanel />
      {/* useSearchParams needs a Suspense boundary in the App Router. */}
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
