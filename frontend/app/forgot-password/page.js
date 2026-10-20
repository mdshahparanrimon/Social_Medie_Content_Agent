'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import AuthLayout, { Alert, SubmitButton } from '@/components/AuthLayout';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { message } = await api('/auth/forgot-password', { method: 'POST', body: { email } });
      setSent(message);
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  const back = (
    <Link href="/login" className="font-medium text-accent-600 hover:underline dark:text-accent-700">
      ← Back to sign in
    </Link>
  );

  if (sent) {
    return (
      <AuthLayout title="Check your email" subtitle={sent} footer={back}>
        <Alert tone="info">
          The link works once and expires in 1 hour. Don&apos;t see it? Check your spam folder, or{' '}
          <button type="button" className="font-medium underline" onClick={() => setSent('')}>
            try another email
          </button>
          .
        </Alert>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Forgot your password?" subtitle="Enter your email and we'll send you a link to choose a new one." footer={back}>
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
        <SubmitButton busy={busy} busyLabel="Sending…">Send reset link</SubmitButton>
      </form>
    </AuthLayout>
  );
}
