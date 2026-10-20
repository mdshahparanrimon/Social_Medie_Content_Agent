'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { safeNext, useAuth } from '@/components/auth';
import AuthLayout, { Alert, PasswordInput, PasswordStrength, SocialButtons, SubmitButton, useProviders } from '@/components/AuthLayout';

function SignupForm() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const { setUser } = useAuth();
  const providers = useProviders();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));

  async function submit(e) {
    e.preventDefault();
    if (form.password.length < 8) return setError('Use a password with at least 8 characters.');
    setBusy(true);
    setError('');
    try {
      const { user } = await api('/auth/register', { method: 'POST', body: form });
      setUser(user);
      // Unverified users land on the "check your inbox" screen; afterwards they continue to `next`.
      router.replace(next);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const loginLink = (
    <>
      Already have an account?{' '}
      <Link href={next === '/' ? '/login' : `/login?${new URLSearchParams({ next })}`} className="font-medium text-accent-600 hover:underline dark:text-accent-700">
        Sign in
      </Link>
    </>
  );

  if (providers && !providers.signups) {
    return (
      <AuthLayout title="Sign-ups are closed" subtitle="We're not accepting new accounts right now. Please check back later." footer={loginLink} />
    );
  }

  return (
    <AuthLayout title="Create your account" subtitle="Start planning on-brand content in minutes." footer={loginLink}>
      <SocialButtons providers={providers} next={next} verb="Sign up" />
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Alert>{error}</Alert>
        <div>
          <label htmlFor="name" className="label">Full name</label>
          <input
            id="name"
            className="input"
            value={form.name}
            onChange={(e) => set('name')(e.target.value)}
            autoComplete="name"
            placeholder="Jane Doe"
            required
            autoFocus
          />
        </div>
        <div>
          <label htmlFor="email" className="label">Work email</label>
          <input
            id="email"
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
          <label htmlFor="password" className="label">Password</label>
          <PasswordInput id="password" value={form.password} onChange={set('password')} autoComplete="new-password" />
          <PasswordStrength password={form.password} />
        </div>
        <SubmitButton busy={busy} busyLabel="Creating account…">Create account</SubmitButton>
        <p className="text-center text-xs text-zinc-500">We&apos;ll send a link to confirm your email address.</p>
      </form>
    </AuthLayout>
  );
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}
