'use client';

import { useEffect, type ReactNode } from 'react';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * The one surface in the system. Everything that holds content is this shape:
 * a hairline border, a soft two-layer shadow, and a 20px radius.
 *
 * `interactive` adds a lift on hover — only for cards that are themselves a
 * link or a button. A card that lifts but does nothing is a lie.
 */
export function Card({
  children, className, interactive = false, as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  interactive?: boolean;
  as?: 'div' | 'section' | 'article';
}) {
  return (
    <Tag
      className={cx(
        'surface-card rounded-card',
        interactive &&
          'transition-[box-shadow,transform] duration-200 ease-soft hover:-translate-y-0.5 hover:shadow-raised',
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export function CardHeader({
  title, hint, action, icon,
}: { title: string; hint?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-chip bg-brand-soft text-brand">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h2 className="font-display text-sm font-semibold text-ink display-tight">{title}</h2>
          {hint && <p className="mt-0.5 text-xs text-ink-muted">{hint}</p>}
        </div>
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

/**
 * The eyebrow is not decoration: it names the section of the app the page
 * belongs to, which is the one thing the page title cannot say about itself.
 */
export function PageHeader({
  title, subtitle, action, eyebrow,
}: { title: string; subtitle?: string; action?: ReactNode; eyebrow?: string }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && (
          <p className="mb-1.5 text-[0.6875rem] font-semibold tracking-[0.14em] text-accent-strong uppercase">
            {eyebrow}
          </p>
        )}
        <h1 className="font-display text-2xl font-semibold text-ink display-tight sm:text-[1.75rem]">
          {title}
        </h1>
        {subtitle && <p className="mt-1.5 text-sm text-ink-muted">{subtitle}</p>}
      </div>
      {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
    </header>
  );
}

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'brand' | 'accent';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-ink-muted ring-border',
  ok: 'bg-ok-soft text-ok ring-ok/25',
  warn: 'bg-warn-soft text-warn ring-warn/25',
  danger: 'bg-danger-soft text-danger ring-danger/25',
  info: 'bg-info-soft text-info ring-info/25',
  brand: 'bg-brand-soft text-brand ring-brand/25',
  accent: 'bg-accent-soft text-accent-strong ring-accent/25',
};

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset',
        TONE_CLASS[tone],
      )}
    >
      {children}
    </span>
  );
}

/**
 * A pressable control.
 *
 * Primary carries the brand gradient because it is the only button on a page
 * that commits money or state; everything else is quieter by a full step. The
 * 1px press translation is the whole animation budget for a button.
 */
export function Button({
  children, onClick, type = 'button', variant = 'primary', disabled, size = 'md', title, className,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
  title?: string;
  className?: string;
}) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-field font-medium ' +
    'transition-[background-color,box-shadow,transform,border-color] duration-150 ease-soft ' +
    'active:translate-y-px disabled:pointer-events-none disabled:opacity-50';
  const sizes = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-4 py-2.5 text-sm',
    lg: 'px-5 py-3 text-sm',
  };
  const variants = {
    primary:
      'brand-ramp text-white shadow-card hover:shadow-raised hover:brightness-110',
    accent: 'bg-accent text-white shadow-card hover:bg-accent-strong hover:shadow-raised',
    secondary: 'border border-border bg-surface text-ink shadow-card hover:bg-surface-2',
    ghost: 'text-ink-muted hover:bg-surface-2 hover:text-ink',
    danger: 'border border-danger/30 bg-danger-soft text-danger hover:bg-danger/15',
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cx(base, sizes[size], variants[variant], className)}
    >
      {children}
    </button>
  );
}

/**
 * Focus is a soft accent halo rather than a hard border swap: it reads as the
 * field waking up instead of changing shape, and it survives dark mode where a
 * border colour change alone is nearly invisible.
 */
const FIELD =
  'w-full rounded-field border border-border bg-surface px-3.5 py-2.5 text-sm text-ink ' +
  'placeholder:text-ink-faint transition-[border-color,box-shadow] duration-150 ease-soft ' +
  'focus:border-accent focus:ring-4 focus:ring-accent/15 focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

export function Field({
  label, children, hint,
}: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-ink-muted">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-ink-faint">{hint}</span>}
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(FIELD, props.className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(FIELD, 'pe-9', props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(FIELD, 'min-h-20 resize-y', props.className)} />;
}

/** A checkbox with a real hit target — the native 13px box is not one. */
export function Checkbox({
  checked, onChange, label, disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  /** Shown, dimmed, and inert — for a choice that exists but is not yours. */
  disabled?: boolean;
}) {
  return (
    <label
      className={cx(
        'flex items-center gap-2.5 rounded-chip px-1 py-1.5 text-xs transition-colors',
        disabled
          ? 'cursor-not-allowed text-ink-faint'
          : 'cursor-pointer text-ink-muted hover:text-ink',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 shrink-0 rounded-[0.3rem] accent-[var(--color-accent)]"
      />
      {label}
    </label>
  );
}

/** An empty screen is an invitation to act, so it can carry the action. */
export function EmptyState({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="px-5 py-16 text-center">
      <span
        aria-hidden
        className="mx-auto mb-4 block h-10 w-10 rounded-tile bg-surface-2 ring-1 ring-border ring-inset"
      />
      <p className="text-sm text-ink-faint">{message}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/**
 * A loading placeholder shaped like the thing that is coming.
 *
 * Everything about the skeleton is decoration except its dimensions — those
 * are the message. Give it the width and height of the real content so the
 * layout does not jump when the data lands.
 */
export function Skeleton({
  className, style,
}: { className?: string; style?: React.CSSProperties }) {
  return <span aria-hidden style={style} className={cx('skeleton block', className)} />;
}

/**
 * The loading state for a whole panel.
 *
 * `label` is not rendered — it goes to assistive tech, which cannot see a
 * shimmer. Sighted readers get the shape; screen readers get the sentence.
 */
export function Spinner({ label, lines = 3 }: { label: string; lines?: number }) {
  return (
    <div className="space-y-3 px-5 py-6" role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="flex items-center justify-between gap-6">
          <Skeleton className="h-3.5 w-full max-w-[14rem]" />
          <Skeleton className="h-3.5 w-20 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** A grid of stat tiles, before the numbers arrive. */
export function StatsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" role="status" aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <Card key={i} className="p-4">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-3 h-7 w-32" />
          <Skeleton className="mt-2.5 h-2.5 w-20" />
        </Card>
      ))}
    </div>
  );
}

/** A chart-shaped placeholder: bars of varying height, not rows of text. */
export function ChartSkeleton({ label, height = 220 }: { label: string; height?: number }) {
  // Fixed heights rather than random ones, so the placeholder does not
  // re-shuffle on every render.
  const bars = [52, 74, 41, 88, 63, 96, 58, 79, 45, 84, 68, 92];
  return (
    <div className="px-5 py-5" role="status" aria-busy="true" style={{ height }}>
      <span className="sr-only">{label}</span>
      <div className="flex h-full items-end gap-2">
        {bars.map((h, i) => (
          <Skeleton key={i} className="flex-1 rounded-t-chip" style={{ height: `${h}%` }} />
        ))}
      </div>
    </div>
  );
}

/**
 * A whole page, before anything has loaded. Used where a route cannot render
 * its header until it knows what it is showing.
 */
export function PageSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div className="mb-6">
        <Skeleton className="h-2.5 w-16" />
        <Skeleton className="mt-2.5 h-7 w-56" />
        <Skeleton className="mt-2.5 h-3.5 w-80 max-w-full" />
      </div>
      <StatsSkeleton />
      <Card className="mt-5">
        <div className="border-b border-border px-5 py-4">
          <Skeleton className="h-3.5 w-32" />
        </div>
        <Spinner label={label} lines={6} />
      </Card>
    </div>
  );
}

export function ErrorState({ message, detail }: { message: string; detail?: string }) {
  return (
    <div className="px-5 py-12 text-center">
      <p className="text-sm font-medium text-danger">{message}</p>
      {detail && <p className="mt-1.5 text-xs break-words text-ink-faint">{detail}</p>}
    </div>
  );
}

/** An inline result line — a sync summary, a save confirmation, a refusal. */
export function Notice({
  tone = 'info', children,
}: { tone?: 'info' | 'ok' | 'warn' | 'danger'; children: ReactNode }) {
  const tones = {
    info: 'bg-info-soft text-info ring-info/20',
    ok: 'bg-ok-soft text-ok ring-ok/20',
    warn: 'bg-warn-soft text-warn ring-warn/20',
    danger: 'bg-danger-soft text-danger ring-danger/20',
  };
  return (
    <div
      role="status"
      className={cx(
        'rounded-field px-3.5 py-2.5 text-xs ring-1 ring-inset break-words',
        tones[tone],
      )}
    >
      {children}
    </div>
  );
}

/**
 * Modal dialog.
 *
 * Escape closes it and the backdrop is clickable, because a dialog you can
 * only leave by finding the right button is a trap. Body scroll is locked
 * while open so the page behind does not drift.
 */
export function Modal({
  open, onClose, title, children, footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="close"
        onClick={onClose}
        className="absolute inset-0 bg-brand-strong/45 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative z-10 max-h-[90dvh] w-full overflow-y-auto rounded-t-panel border border-border bg-surface shadow-pop sm:max-w-lg sm:rounded-panel"
      >
        <div className="sticky top-0 flex items-center justify-between gap-3 border-b border-border bg-surface/95 px-5 py-4 backdrop-blur">
          <h2 className="font-display text-base font-semibold text-ink display-tight">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="close"
            className="flex h-8 w-8 items-center justify-center rounded-chip text-lg leading-none text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
          >
            ×
          </button>
        </div>
        <div className="px-5 py-5">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-border px-5 py-4">{footer}</div>
        )}
      </div>
    </div>
  );
}

/** A proportional fill, used to make relative size readable without numbers. */
/**
 * The filters currently applied, as removable chips.
 *
 * A row of selects tells you what you COULD filter by; it does not tell you
 * what you ARE filtering by without reading every control. This states it in
 * one line, and each chip removes its own filter — which is also the fastest
 * way out of a filter combination that returns nothing.
 *
 * Renders nothing when no filter is set, so an unfiltered list stays quiet.
 */
export function ActiveFilters({
  filters, onClear, clearAllLabel, label,
}: {
  filters: Array<{ key: string; label: string; value: string; onRemove: () => void }>;
  onClear: () => void;
  clearAllLabel: string;
  label: string;
}) {
  if (filters.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
      <span className="text-xs font-medium text-ink-muted">{label}</span>
      {filters.map((f) => (
        <span
          key={f.key}
          className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft py-1 ps-3 pe-1 text-xs text-accent-strong ring-1 ring-accent/20"
        >
          <span className="text-ink-muted">{f.label}:</span>
          <span className="font-medium">{f.value}</span>
          <button
            type="button"
            onClick={f.onRemove}
            aria-label={`${f.label}: ${f.value} — ×`}
            className="grid h-5 w-5 place-items-center rounded-full text-accent-strong/70 transition-colors hover:bg-accent/15 hover:text-accent-strong"
          >
            <svg aria-hidden viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={onClear}
        className="rounded-chip px-2 py-1 text-xs font-medium text-ink-muted underline-offset-2 transition-colors hover:bg-surface-2 hover:text-ink hover:underline"
      >
        {clearAllLabel}
      </button>
    </div>
  );
}

export function FillBar({
  value, max, tone = 'brand',
}: { value: number; max: number; tone?: 'brand' | 'ok' | 'danger' | 'accent' }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (Math.abs(value) / max) * 100)) : 0;
  const bg = {
    brand: 'brand-ramp', ok: 'bg-ok', danger: 'bg-danger', accent: 'bg-accent',
  }[tone];
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
      <div
        className={cx('h-full rounded-full transition-[width] duration-500 ease-soft', bg)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/**
 * The benzene ring, drawn as a field of bonds and atoms.
 *
 * This is the one piece of ornament in the system, and it appears in exactly
 * one place — behind the sign-in panel. The subject is organic chemistry; the
 * lattice is the subject's own diagram, not a generic pattern.
 */
export function MoleculeField({ className }: { className?: string }) {
  const R = 16;
  const dx = (Math.sqrt(3) * R) / 2;
  const hex = (cx0: number, cy0: number) =>
    [
      [cx0, cy0 - R], [cx0 + dx, cy0 - R / 2], [cx0 + dx, cy0 + R / 2],
      [cx0, cy0 + R], [cx0 - dx, cy0 + R / 2], [cx0 - dx, cy0 - R / 2],
    ].map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');

  return (
    <svg
      aria-hidden
      className={className}
      width="100%"
      height="100%"
      viewBox="0 0 220 220"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <pattern id="benzene" width={dx * 2} height={R * 3} patternUnits="userSpaceOnUse">
          <polygon points={hex(dx, R)} fill="none" stroke="currentColor" strokeWidth="0.9" />
          <polygon points={hex(0, R * 2.5)} fill="none" stroke="currentColor" strokeWidth="0.9" />
          <polygon
            points={hex(dx * 2, R * 2.5)}
            fill="none"
            stroke="currentColor"
            strokeWidth="0.9"
          />
          <circle cx={dx} cy={0} r="1.4" fill="currentColor" />
          <circle cx={0} cy={R * 1.5} r="1.4" fill="currentColor" />
          <circle cx={dx * 2} cy={R * 1.5} r="1.4" fill="currentColor" />
        </pattern>
        <radialGradient id="benzene-fade" cx="50%" cy="45%" r="62%">
          <stop offset="0%" stopColor="white" stopOpacity="0.85" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <mask id="benzene-mask">
          <rect width="220" height="220" fill="url(#benzene-fade)" />
        </mask>
      </defs>
      <rect width="220" height="220" fill="url(#benzene)" mask="url(#benzene-mask)" />
    </svg>
  );
}
