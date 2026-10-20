'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { safeNext, useAuth } from '@/components/auth';
import AuthLayout, { Alert, PasswordInput, SocialButtons, SubmitButton, useProviders } from '@/components/AuthLayout';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const { setUser } = useAuth();
  const providers = useProviders();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(params.get('error') || '');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { user } = await api('/auth/login', { method: 'POST', body: { email, password } });
      setUser(user);
      router.replace(next);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const signupHref = next === '/' ? '/signup' : `/signup?${new URLSearchParams({ next })}`;

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to plan, write and publish your content."
      footer={
        providers?.signups !== false && (
          <>
            New here?{' '}
            <Link href={signupHref} className="font-medium text-accent-600 hover:underline dark:text-accent-700">
              Create an account
            </Link>
          </>
        )
      }
    >
      <SocialButtons providers={providers} next={next} />
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Alert>{error}</Alert>
        <div>
          <label htmlFor="email" className="label">Email</label>
          <input
            id="email"
            type="email"
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            placeholder="you@company.com"
            required
            autoFocus
          />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label htmlFor="password" className="text-sm font-medium text-zinc-700">Password</label>
            <Link href="/forgot-password" className="text-xs font-medium text-accent-600 hover:underline dark:text-accent-700">
              Forgot password?
            </Link>
          </div>
          <PasswordInput id="password" value={password} onChange={setPassword} autoComplete="current-password" />
        </div>
        <SubmitButton busy={busy} busyLabel="Signing in…">Sign in</SubmitButton>
      </form>
    </AuthLayout>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
