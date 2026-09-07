'use client';

import { useEffect, type ReactNode } from 'react';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('rounded-[--radius-card] border border-border bg-surface', className)}>
      {children}
    </div>
  );
}

export function CardHeader({
  title, hint, action,
}: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-ink-muted">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({
  title, subtitle, action,
}: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>}
      </div>
      {action}
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
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset',
        TONE_CLASS[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Button({
  children, onClick, type = 'button', variant = 'primary', disabled, size = 'md', title,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
  disabled?: boolean;
  size?: 'sm' | 'md';
  title?: string;
}) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-[--radius-field] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';
  const sizes = { sm: 'px-2.5 py-1.5 text-xs', md: 'px-4 py-2 text-sm' };
  const variants = {
    primary: 'bg-brand text-white hover:bg-brand-hover',
    accent: 'bg-accent text-white hover:bg-accent-strong',
    secondary: 'border border-border bg-surface text-ink hover:bg-surface-2',
    ghost: 'text-ink-muted hover:bg-surface-2 hover:text-ink',
    danger: 'border border-danger/30 bg-danger-soft text-danger hover:bg-danger/15',
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cx(base, sizes[size], variants[variant])}
    >
      {children}
    </button>
  );
}

const FIELD =
  'w-full rounded-[--radius-field] border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none';

export function Field({
  label, children, hint,
}: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-faint">{hint}</span>}
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(FIELD, props.className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(FIELD, props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(FIELD, 'min-h-20', props.className)} />;
}

export function EmptyState({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="px-5 py-14 text-center">
      <p className="text-sm text-ink-faint">{message}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 px-5 py-14 text-sm text-ink-muted">
      <span
        aria-hidden
        className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-accent"
      />
      {label}
    </div>
  );
}

export function ErrorState({ message, detail }: { message: string; detail?: string }) {
  return (
    <div className="px-5 py-10 text-center">
      <p className="text-sm font-medium text-danger">{message}</p>
      {detail && <p className="mt-1 text-xs break-words text-ink-faint">{detail}</p>}
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
        className="absolute inset-0 bg-brand-strong/40 backdrop-blur-[2px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative z-10 max-h-[90dvh] w-full overflow-y-auto rounded-t-[--radius-card] border border-border bg-surface shadow-xl sm:max-w-lg sm:rounded-[--radius-card]"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="font-display text-base font-semibold text-ink">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-lg leading-none text-ink-faint hover:bg-surface-2 hover:text-ink"
          >
            ×
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-border px-5 py-4">{footer}</div>
        )}
      </div>
    </div>
  );
}

/** A proportional fill, used to make relative size readable without numbers. */
export function FillBar({
  value, max, tone = 'brand',
}: { value: number; max: number; tone?: 'brand' | 'ok' | 'danger' | 'accent' }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (Math.abs(value) / max) * 100)) : 0;
  const bg = {
    brand: 'bg-brand', ok: 'bg-ok', danger: 'bg-danger', accent: 'bg-accent',
  }[tone];
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
      <div className={cx('h-full rounded-full transition-[width]', bg)} style={{ width: `${pct}%` }} />
    </div>
  );
}
