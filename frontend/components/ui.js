import Link from 'next/link';
import { PLATFORMS } from '@/lib/api';

const BUTTON_STYLES = {
  primary: 'bg-accent-600 text-white hover:bg-accent-700 dark:hover:bg-accent-600 dark:hover:brightness-110 shadow-sm',
  secondary: 'border border-zinc-300 bg-surface text-zinc-800 hover:bg-zinc-50 shadow-sm',
  danger: 'text-red-600 hover:bg-red-50',
  ghost: 'text-zinc-600 hover:bg-zinc-100',
};

const buttonClass = (variant, className) =>
  `inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_STYLES[variant]} ${className}`;

export function Button({ variant = 'primary', className = '', ...props }) {
  return <button className={buttonClass(variant, className)} {...props} />;
}

export function ButtonLink({ variant = 'primary', className = '', ...props }) {
  return <Link className={buttonClass(variant, className)} {...props} />;
}

export function Card({ className = '', children }) {
  return <div className={`rounded-xl border border-zinc-200 bg-surface p-5 shadow-sm ${className}`}>{children}</div>;
}

export function PageHeader({ title, description, children }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-serif text-[26px] font-semibold tracking-tight text-zinc-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-zinc-500">{description}</p>}
      </div>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

const PLATFORM_COLORS = {
  x: 'bg-black text-white ring-1 ring-zinc-700',
  linkedin: 'bg-sky-700 text-white',
  meta: 'bg-blue-600 text-white',
  instagram: 'bg-gradient-to-r from-fuchsia-600 to-orange-500 text-white',
};

export function PlatformBadge({ platform }) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-semibold ${PLATFORM_COLORS[platform]}`}>
      {PLATFORMS[platform]?.label || platform}
    </span>
  );
}

const STATUS_STYLES = {
  draft: 'bg-amber-100 text-amber-800',
  approved: 'bg-accent-100 text-accent-800',
  publishing: 'bg-accent-100 text-accent-800',
  published: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-red-100 text-red-800',
};

const STATUS_LABELS = { approved: 'scheduled' };

export function StatusBadge({ status, simulated }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}>
      {STATUS_LABELS[status] || status}
      {simulated ? ' (simulated)' : ''}
    </span>
  );
}

export function ErrorText({ error }) {
  if (!error) return null;
  return <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>;
}
