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

// Outline icons (24px grid, drawn with the current text color).
const ICONS = {
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m21 16-5-5-9 9" />
    </>
  ),
  video: (
    <>
      <rect x="3" y="6" width="13" height="12" rx="2" />
      <path d="m16 10.5 5-3v9l-5-3" />
    </>
  ),
  document: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h4" />
    </>
  ),
  sparkles: <path d="M11 3l1.6 4.4L17 9l-4.4 1.6L11 15l-1.6-4.4L5 9l4.4-1.6zM18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z" />,
  upload: (
    <>
      <path d="M12 15V4m0 0-4 4m4-4 4 4" />
      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
  chevron: <path d="m9 6 6 6-6 6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  send: <path d="M21 3 10 14M21 3l-7 18-4-7-7-4z" />,
  external: <path d="M14 4h6v6M20 4 10 14M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />,
  pencil: <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />,
  undo: <path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
};

export function Icon({ name, className = 'size-4' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      {ICONS[name]}
    </svg>
  );
}

// "Expand all / Collapse all" for a list of collapsible cards. Pass the result as each card's `expand`.
export function ExpandAll({ onChange }) {
  const item = 'rounded-md px-2.5 py-1 text-xs font-medium text-zinc-600 transition hover:bg-surface hover:text-zinc-900 hover:shadow-sm';
  return (
    <div className="inline-flex rounded-lg border border-zinc-200 bg-zinc-100 p-0.5">
      <button type="button" className={item} onClick={() => onChange({ open: true, at: Date.now() })}>
        Expand all
      </button>
      <button type="button" className={item} onClick={() => onChange({ open: false, at: Date.now() })}>
        Collapse all
      </button>
    </div>
  );
}

// The platform's mark on its brand color, for card headers.
const PLATFORM_MARKS = {
  x: <span className="text-base font-bold leading-none">X</span>,
  linkedin: <span className="text-[15px] font-bold leading-none tracking-tight">in</span>,
  meta: <span className="text-lg font-bold leading-none">f</span>,
  instagram: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-[18px]" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="4.5" />
      <circle cx="12" cy="12" r="3.6" />
      <circle cx="16.6" cy="7.4" r="0.6" fill="currentColor" />
    </svg>
  ),
};

export function PlatformIcon({ platform, className = 'size-9' }) {
  return (
    <span
      title={PLATFORMS[platform]?.label}
      className={`inline-flex shrink-0 items-center justify-center rounded-lg shadow-sm ${PLATFORM_COLORS[platform]} ${className}`}
    >
      {PLATFORM_MARKS[platform]}
    </span>
  );
}

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
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_STYLES[status]}`}>
      <span className={`size-1.5 rounded-full bg-current ${status === 'publishing' ? 'animate-pulse' : 'opacity-70'}`} />
      {STATUS_LABELS[status] || status}
      {simulated ? ' (simulated)' : ''}
    </span>
  );
}

export function ErrorText({ error }) {
  if (!error) return null;
  return <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>;
}
