'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/components/auth';
import AuthLayout, { Alert, useProviders } from '@/components/AuthLayout';
import { Button } from '@/components/ui';

// Signed in, but the email address isn't confirmed yet: nothing else in the app is reachable.
export default function VerifyEmailGate() {
  const router = useRouter();
  const { user, refresh, logout } = useAuth();
  const providers = useProviders();
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);

  // Confirmed in another tab? Pick it up when the user comes back here.
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  async function resend() {
    setBusy('resend');
    setResult(null);
    try {
      const { message } = await api('/auth/resend-verification', { method: 'POST' });
      setResult({ ok: true, message });
    } catch (err) {
      setResult({ ok: false, message: err.message });
    }
    setBusy(null);
  }

  async function check() {
    setBusy('check');
    const me = await refresh();
    if (me && !me.email_verified) setResult({ ok: false, message: "Not confirmed yet. Click the link in the email first." });
    setBusy(null);
  }

  async function signOut() {
    await logout();
    router.replace('/login');
  }

  return (
    <AuthLayout
      title="Check your inbox"
      subtitle={
        <>
          We sent a confirmation link to <span className="font-medium text-zinc-900">{user.email}</span>. Click it to finish setting
          up your account.
        </>
      }
      footer={
        <>
          Wrong email?{' '}
          <button onClick={signOut} className="font-medium text-accent-600 hover:underline dark:text-accent-700">
            Sign out and start over
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {result && <Alert tone={result.ok ? 'success' : 'error'}>{result.message}</Alert>}
        {providers && !providers.email_delivery && (
          <Alert tone="info">
            Email sending isn&apos;t set up yet, so the link was printed in the backend terminal. Add a Resend key in Settings →
            Sign-in &amp; email to send real emails.
          </Alert>
        )}
        <div className="grid gap-2.5">
          <Button onClick={check} disabled={busy !== null} className="py-2.5">
            {busy === 'check' ? 'Checking…' : "I've confirmed my email"}
          </Button>
          <Button variant="secondary" onClick={resend} disabled={busy !== null} className="py-2.5">
            {busy === 'resend' ? 'Sending…' : 'Resend the email'}
          </Button>
        </div>
        <p className="text-center text-xs text-zinc-500">Can&apos;t find it? Check your spam or promotions folder.</p>
      </div>
    </AuthLayout>
  );
}
