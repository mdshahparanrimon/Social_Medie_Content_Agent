'use client';

import Link from 'next/link';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/components/auth';
import AuthLayout, { Alert, FullPageSpinner } from '@/components/AuthLayout';
import { ButtonLink } from '@/components/ui';

function Verify() {
  const token = useSearchParams().get('token') || '';
  const { setUser } = useAuth();
  const [state, setState] = useState(token ? 'working' : 'missing');
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    // The token is single-use, so React's double effect in development must not send it twice.
    if (!token || started.current) return;
    started.current = true;
    api('/auth/verify-email', { method: 'POST', body: { token } })
      .then(({ user }) => {
        setUser(user);
        setState('done');
      })
      .catch((err) => {
        setError(err.message);
        setState('failed');
      });
  }, [token, setUser]);

  if (state === 'working') return <FullPageSpinner />;

  if (state === 'done') {
    return (
      <AuthLayout title="Email confirmed" subtitle="Thanks! Your account is ready.">
        <ButtonLink href="/brand" className="w-full py-2.5">
          Set up your Brand Brain →
        </ButtonLink>
        <p className="mt-4 text-center text-sm">
          <Link href="/" className="text-zinc-500 hover:underline">
            or go to the dashboard
          </Link>
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={state === 'missing' ? 'Link incomplete' : "We couldn't confirm your email"}
      subtitle="Sign in, and we'll offer to send you a fresh link."
      footer={
        <Link href="/login" className="font-medium text-accent-600 hover:underline dark:text-accent-700">
          Go to sign in
        </Link>
      }
    >
      <Alert>{error || 'Open the confirmation link from your email again.'}</Alert>
    </AuthLayout>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <Verify />
    </Suspense>
  );
}
