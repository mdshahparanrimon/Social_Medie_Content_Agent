'use client';

import Link from 'next/link';
import { Suspense, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { safeNext, useAuth } from '@/components/auth';
import { Alert, PasswordInput, PasswordStrength, SocialButtons, SubmitButton, useProviders } from '@/components/AuthLayout';

// Sign in and sign up happen in a popup over the app, so guests can look around the chat first.
// Open it with useAuthModal().openAuth('login' | 'signup', next), or with ?auth=login|signup in the URL
// (old /login and /signup links, the sign-in wall on other pages and Google/LinkedIn errors use that).

const AuthModalContext = createContext({ openAuth: () => {} });
export const useAuthModal = () => useContext(AuthModalContext);

const URL_KEYS = ['auth', 'next', 'error'];

function UrlOpener({ onOpen }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    const mode = params.get('auth');
    if (mode !== 'login' && mode !== 'signup') return;
    onOpen(mode, params.get('next'), params.get('error') || '');
    // Take the popup's keys out of the address bar; anything else (an open chat) stays.
    const rest = new URLSearchParams(params);
    URL_KEYS.forEach((k) => rest.delete(k));
    router.replace(rest.size ? `${pathname}?${rest}` : pathname, { scroll: false });
  }, [params, pathname, router, onOpen]);
  return null;
}

export function AuthModalProvider({ children }) {
  const router = useRouter();
  const { status } = useAuth();
  const [state, setState] = useState(null); // { mode, next, error } while open

  const openAuth = useCallback((mode = 'login', next = null, error = '') => {
    setState({ mode, next: next ? safeNext(next) : null, error });
  }, []);
  const close = useCallback(() => setState(null), []);

  // Signed in (here, in another tab, or already): close the popup and go where the user was heading.
  useEffect(() => {
    if (status === 'signed-in' && state) {
      const { next } = state;
      setState(null);
      if (next && next !== window.location.pathname + window.location.search) router.push(next);
    }
  }, [status, state, router]);

  const value = useMemo(() => ({ openAuth }), [openAuth]);
  return (
    <AuthModalContext.Provider value={value}>
      {children}
      <Suspense fallback={null}>
        <UrlOpener onOpen={openAuth} />
      </Suspense>
      {state && status !== 'signed-in' && (
        <AuthDialog {...state} onMode={(mode) => setState((s) => ({ ...s, mode, error: '' }))} onClose={close} />
      )}
    </AuthModalContext.Provider>
  );
}

const PERKS = ['Chat with an agent that knows your brand', 'Drafts for X, LinkedIn, Facebook and Instagram', 'Nothing is posted until you approve it'];

function AuthDialog({ mode, next, error: initialError, onMode, onClose }) {
  const { setUser } = useAuth();
  const providers = useProviders();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const dialog = useRef(null);
  const signup = mode === 'signup';
  const signupsClosed = providers && providers.signups === false;
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));
  const returnTo = next || (typeof window === 'undefined' ? '/' : window.location.pathname + window.location.search);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.querySelector('input')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  async function submit(e) {
    e.preventDefault();
    if (signup && form.password.length < 8) return setError('Use a password with at least 8 characters.');
    setBusy(true);
    setError('');
    try {
      const { user } = signup
        ? await api('/auth/register', { method: 'POST', body: form })
        : await api('/auth/login', { method: 'POST', body: { email: form.email, password: form.password } });
      // The provider closes the popup and goes to `next`; new accounts first see "check your inbox".
      setUser(user);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" role="presentation">
      <div className="absolute inset-0 bg-zinc-950/50 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-title"
        className="relative flex max-h-[92dvh] w-full max-w-[860px] overflow-hidden rounded-t-3xl bg-surface shadow-2xl ring-1 ring-zinc-200 sm:rounded-3xl"
      >
        {/* Brand side (wide screens) */}
        <aside className="relative hidden w-[42%] shrink-0 flex-col overflow-hidden bg-accent-600 p-8 text-white md:flex dark:bg-[color-mix(in_oklab,var(--a-600)_55%,black)]">
          <div className="pointer-events-none absolute -top-20 -right-20 size-72 rounded-full bg-white/10" />
          <div className="pointer-events-none absolute -bottom-24 -left-16 size-64 rounded-full bg-white/5" />
          <span className="relative grid size-11 place-items-center rounded-2xl bg-white/15 ring-1 ring-white/25">
            <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 3l1.8 4.9L19 9.7l-4.9 1.8L12 16.4l-1.8-4.9L5.3 9.7l4.9-1.8L12 3ZM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z" />
            </svg>
          </span>
          <h2 className="relative mt-auto font-serif text-3xl leading-tight font-semibold">Your AI content team, on brand and on schedule.</h2>
          <ul className="relative mt-6 space-y-3">
            {PERKS.map((perk) => (
              <li key={perk} className="flex items-start gap-2.5 text-sm text-white/85">
                <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-white/20 text-[11px] font-bold">✓</span>
                {perk}
              </li>
            ))}
          </ul>
        </aside>

        {/* Form side */}
        <div className="min-w-0 flex-1 overflow-y-auto px-6 pt-6 pb-7 sm:px-9 sm:pt-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 id="auth-title" className="font-serif text-2xl font-semibold tracking-tight text-zinc-900">
                {signup ? 'Create your account' : 'Welcome back'}
              </h1>
              <p className="mt-1 text-sm text-zinc-500">
                {signup ? 'Connect your AI and start creating in minutes.' : 'Sign in to chat with your content agent.'}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="-mt-1 -mr-2 rounded-full p-2 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"
              aria-label="Close"
            >
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>

          <div role="tablist" aria-label="Sign in or sign up" className="mt-6 grid grid-cols-2 rounded-xl bg-zinc-100 p-1 text-sm font-medium">
            {[
              ['login', 'Log in'],
              ['signup', 'Sign up'],
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={mode === key}
                onClick={() => onMode(key)}
                className={`rounded-lg py-2 transition ${mode === key ? 'bg-surface text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-800'}`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="mt-6">
            {signup && signupsClosed ? (
              <Alert tone="info">Sign-ups are closed right now. If you already have an account, log in instead.</Alert>
            ) : (
              <>
                <SocialButtons providers={providers} next={returnTo} verb={signup ? 'Sign up' : 'Continue'} />
                <form onSubmit={submit} className="space-y-4" noValidate>
                  <Alert>{error}</Alert>
                  {signup && (
                    <div>
                      <label htmlFor="auth-name" className="label">Full name</label>
                      <input
                        id="auth-name"
                        className="input"
                        value={form.name}
                        onChange={(e) => set('name')(e.target.value)}
                        autoComplete="name"
                        placeholder="Jane Doe"
                        required
                      />
                    </div>
                  )}
                  <div>
                    <label htmlFor="auth-email" className="label">Email</label>
                    <input
                      id="auth-email"
                      type="email"
                      className="input"
                      value={form.email}
                      onChange={(e) => set('email')(e.target.value)}
                      autoComplete="email"
                      placeholder="you@company.com"
                      required
                    />
                  </div>
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <label htmlFor="auth-password" className="text-sm font-medium text-zinc-700">Password</label>
                      {!signup && (
                        <Link href="/forgot-password" onClick={onClose} className="text-xs font-medium text-accent-600 hover:underline dark:text-accent-700">
                          Forgot password?
                        </Link>
                      )}
                    </div>
                    <PasswordInput
                      id="auth-password"
                      value={form.password}
                      onChange={set('password')}
                      autoComplete={signup ? 'new-password' : 'current-password'}
                    />
                    {signup && <PasswordStrength password={form.password} />}
                  </div>
                  <SubmitButton busy={busy} busyLabel={signup ? 'Creating account…' : 'Signing in…'}>
                    {signup ? 'Create account' : 'Log in'}
                  </SubmitButton>
                  {signup && <p className="text-center text-xs text-zinc-500">We&apos;ll send a link to confirm your email address.</p>}
                </form>
              </>
            )}
          </div>

          <p className="mt-6 text-center text-sm text-zinc-500">
            {signup ? 'Already have an account? ' : 'New to Content Agent? '}
            <button type="button" onClick={() => onMode(signup ? 'login' : 'signup')} className="font-medium text-accent-600 hover:underline dark:text-accent-700">
              {signup ? 'Log in' : 'Create an account'}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
