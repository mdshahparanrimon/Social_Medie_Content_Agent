'use client';

import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/components/auth';
import AuthLayout, { Alert, PasswordInput, PasswordStrength, SubmitButton } from '@/components/AuthLayout';

function ResetForm() {
  const router = useRouter();
  const token = useSearchParams().get('token') || '';
  const { setUser } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (password !== confirm) return setError("The two passwords don't match.");
    setBusy(true);
    setError('');
    try {
      const { user } = await api('/auth/reset-password', { method: 'POST', body: { token, password } });
      setUser(user);
      router.replace('/');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const footer = (
    <Link href="/forgot-password" className="font-medium text-accent-600 hover:underline dark:text-accent-700">
      Request a new link
    </Link>
  );

  if (!token) {
    return (
      <AuthLayout title="Link incomplete" subtitle="Open the reset link from your email again, or request a new one." footer={footer} />
    );
  }

  return (
    <AuthLayout title="Choose a new password" subtitle="You'll be signed in, and signed out on all other devices." footer={footer}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Alert>{error}</Alert>
        <div>
          <label htmlFor="password" className="label">New password</label>
          <PasswordInput id="password" value={password} onChange={setPassword} autoComplete="new-password" />
          <PasswordStrength password={password} />
        </div>
        <div>
          <label htmlFor="confirm" className="label">Confirm new password</label>
          <PasswordInput id="confirm" value={confirm} onChange={setConfirm} autoComplete="new-password" />
        </div>
        <SubmitButton busy={busy} busyLabel="Saving…">Save password and sign in</SubmitButton>
      </form>
    </AuthLayout>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
