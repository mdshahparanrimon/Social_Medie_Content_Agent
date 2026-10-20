'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ModeSwitch } from '@/components/theme';

const FEATURES = [
  ['Plan a week of content in seconds', 'The Strategist turns your Brand Brain into a posting calendar.'],
  ['On-brand drafts for every platform', 'X, LinkedIn, Facebook and Instagram, each in its own format.'],
  ['Nothing posts without your approval', 'Edit, rewrite with feedback, then schedule with one click.'],
];

export function Logo({ inverted = false }) {
  return (
    <Link href="/" className="inline-flex items-center gap-2.5">
      <span className={`grid size-9 place-items-center rounded-lg shadow-sm ${inverted ? 'bg-white/15 text-white ring-1 ring-white/25' : 'bg-accent-600 text-white'}`}>
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4 12a8 8 0 0 1 14.3-4.9M20 12a8 8 0 0 1-14.3 4.9M18 3v4h-4M6 21v-4h4" />
        </svg>
      </span>
      <span className={`font-serif text-xl font-semibold tracking-tight ${inverted ? 'text-white' : 'text-zinc-900'}`}>Content Agent</span>
    </Link>
  );
}

// Classic split screen: brand panel on the left (desktop), the form on the right.
export default function AuthLayout({ title, subtitle, children, footer }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="relative hidden overflow-hidden bg-accent-600 p-12 text-white lg:flex lg:flex-col dark:bg-[color-mix(in_oklab,var(--a-600)_55%,black)]">
        <div className="pointer-events-none absolute -right-24 -top-24 size-96 rounded-full bg-white/10" />
        <div className="pointer-events-none absolute -bottom-32 -left-20 size-80 rounded-full bg-white/5" />
        <Logo inverted />
        <div className="relative mt-auto max-w-md">
          <h2 className="font-serif text-4xl leading-tight font-semibold">Your AI content team, on brand and on schedule.</h2>
          <ul className="mt-10 space-y-6">
            {FEATURES.map(([heading, text]) => (
              <li key={heading} className="flex gap-3">
                <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-white/20 text-xs font-bold">✓</span>
                <div>
                  <div className="font-medium">{heading}</div>
                  <div className="text-sm text-white/75">{text}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative mt-12 text-xs text-white/60">© {new Date().getFullYear()} Content Agent</p>
      </aside>

      <main className="flex flex-col px-4 py-6 sm:px-8">
        <div className="flex items-center justify-between">
          <span className="lg:invisible">
            <Logo />
          </span>
          <ModeSwitch />
        </div>
        <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-10">
          <h1 className="font-serif text-3xl font-semibold tracking-tight text-zinc-900">{title}</h1>
          {subtitle && <p className="mt-2 text-sm text-zinc-500">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-8 text-center text-sm text-zinc-500">{footer}</div>}
        </div>
      </main>
    </div>
  );
}

export function Alert({ tone = 'error', children }) {
  if (!children) return null;
  const tones = {
    error: 'border-red-200 bg-red-50 text-red-700 dark:border-transparent',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-transparent',
    info: 'border-accent-100 bg-accent-50 text-accent-800 dark:border-transparent',
  };
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-lg border px-3.5 py-2.5 text-sm ${tones[tone]}`}>
      {children}
    </div>
  );
}

export function SubmitButton({ busy, children, busyLabel }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-accent-700 disabled:cursor-not-allowed disabled:opacity-60 dark:hover:bg-accent-600 dark:hover:brightness-110"
    >
      {busy && <span className="size-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
      {busy ? busyLabel || 'Please wait…' : children}
    </button>
  );
}

export function PasswordInput({ id, value, onChange, autoComplete, placeholder }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        className="input pr-16"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
        required
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        className="absolute inset-y-0 right-0 px-3 text-xs font-medium text-zinc-500 hover:text-zinc-800"
        aria-label={visible ? 'Hide password' : 'Show password'}
      >
        {visible ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}

// A rough guide for the user; the server enforces the real rules.
export function passwordScore(password) {
  if (!password) return 0;
  let score = password.length >= 8 ? 1 : 0;
  if (password.length >= 12) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score += 1;
  return Math.min(score, 4);
}

const STRENGTH = [
  ['Too short', 'bg-red-500'],
  ['Weak', 'bg-red-500'],
  ['Fair', 'bg-amber-500'],
  ['Good', 'bg-emerald-500'],
  ['Strong', 'bg-emerald-500'],
];

export function PasswordStrength({ password }) {
  if (!password) return <p className="hint">At least 8 characters. Longer is stronger.</p>;
  const score = passwordScore(password);
  const [label, color] = STRENGTH[score];
  return (
    <div className="mt-2">
      <div className="flex gap-1">
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={`h-1 flex-1 rounded-full ${i <= score ? color : 'bg-zinc-200'}`} />
        ))}
      </div>
      <p className="hint">{label}{score < 3 && password.length >= 8 ? ': add length, capitals, numbers or symbols' : ''}</p>
    </div>
  );
}

const GOOGLE_ICON = (
  <svg viewBox="0 0 48 48" className="size-5" aria-hidden>
    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
    <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
  </svg>
);

const LINKEDIN_ICON = (
  <svg viewBox="0 0 24 24" className="size-5" aria-hidden>
    <rect width="24" height="24" rx="4" fill="#0A66C2" />
    <path fill="#fff" d="M7.1 9.4h-2.4V19h2.4V9.4zM5.9 5.5a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8zM19.3 13.6c0-2.6-1.4-4.4-3.8-4.4-1.2 0-2.1.6-2.5 1.3V9.4h-2.3V19h2.4v-4.8c0-1.3.4-2.5 1.9-2.5s1.9 1.4 1.9 2.6V19h2.4v-5.4z" />
  </svg>
);

export const PROVIDER_META = {
  google: { label: 'Google', icon: GOOGLE_ICON },
  linkedin: { label: 'LinkedIn', icon: LINKEDIN_ICON },
};

export function useProviders() {
  const [providers, setProviders] = useState(null);
  useEffect(() => {
    api('/auth/providers')
      .then(setProviders)
      .catch(() => setProviders({ google: false, linkedin: false, signups: true, email_delivery: false }));
  }, []);
  return providers;
}

// "Continue with Google / LinkedIn", shown only for the methods the owner has set up.
export function SocialButtons({ providers, next = '/', verb = 'Continue' }) {
  const enabled = ['google', 'linkedin'].filter((p) => providers?.[p]);
  if (enabled.length === 0) return null;
  return (
    <>
      <div className="grid gap-2.5">
        {enabled.map((p) => (
          <a
            key={p}
            href={`/api/auth/${p}/start?${new URLSearchParams({ next })}`}
            className="inline-flex items-center justify-center gap-3 rounded-lg border border-zinc-300 bg-surface px-4 py-2.5 text-sm font-medium text-zinc-800 shadow-sm transition hover:bg-zinc-50"
          >
            {PROVIDER_META[p].icon}
            {verb} with {PROVIDER_META[p].label}
          </a>
        ))}
      </div>
      <div className="my-6 flex items-center gap-3 text-xs uppercase tracking-wider text-zinc-400">
        <span className="h-px flex-1 bg-zinc-200" />
        or
        <span className="h-px flex-1 bg-zinc-200" />
      </div>
    </>
  );
}

export function FullPageSpinner() {
  return (
    <div className="grid min-h-screen place-items-center">
      <span className="size-8 animate-spin rounded-full border-2 border-zinc-200 border-t-accent-600" aria-label="Loading" />
    </div>
  );
}
