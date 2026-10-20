'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { UserAvatar, useAuth } from '@/components/auth';
import { PasswordInput, PasswordStrength, PROVIDER_META, useProviders } from '@/components/AuthLayout';
import { Button, Card, PageHeader } from '@/components/ui';

function Result({ result }) {
  if (!result) return null;
  return <span className={`text-sm ${result.ok ? 'text-emerald-700' : 'text-red-600'}`}>{result.message}</span>;
}

function SectionCard({ title, description, children, tone }) {
  return (
    <Card className={`grid gap-6 md:grid-cols-[220px_minmax(0,1fr)] ${tone === 'danger' ? 'border-red-200 dark:border-red-100' : ''}`}>
      <div>
        <h2 className={`font-serif text-lg font-semibold ${tone === 'danger' ? 'text-red-700' : 'text-zinc-900'}`}>{title}</h2>
        {description && <p className="mt-1 text-sm text-zinc-500">{description}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </Card>
  );
}

function Profile() {
  const { user, setUser } = useAuth();
  const [name, setName] = useState(user.name);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const { user: updated } = await api('/auth/me', { method: 'PATCH', body: { name } });
      setUser(updated);
      setResult({ ok: true, message: 'Saved' });
    } catch (err) {
      setResult({ ok: false, message: err.message });
    }
    setBusy(false);
  }

  return (
    <SectionCard title="Profile" description="How you appear in the app.">
      <form onSubmit={save} className="space-y-4">
        <div className="flex items-center gap-4">
          <UserAvatar user={user} className="size-14 text-lg" />
          <div className="min-w-0 text-sm">
            <div className="truncate font-medium text-zinc-900">{user.email}</div>
            <div className="text-zinc-500">
              {user.role === 'admin' ? 'Owner (admin)' : 'Member'} · {user.workspace?.name}
            </div>
          </div>
        </div>
        <div className="max-w-md">
          <label htmlFor="name" className="label">Full name</label>
          <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy || !name.trim() || name === user.name}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
          <Result result={result} />
        </div>
      </form>
    </SectionCard>
  );
}

function Password() {
  const { user, setUser } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  async function save(e) {
    e.preventDefault();
    if (next !== confirm) return setResult({ ok: false, message: "The new passwords don't match." });
    setBusy(true);
    setResult(null);
    try {
      const res = await api('/auth/password', { method: 'POST', body: { current_password: current, new_password: next } });
      setUser(res.user);
      setCurrent('');
      setNext('');
      setConfirm('');
      setResult({
        ok: true,
        message: res.signed_out ? `Password saved. Signed out ${res.signed_out} other session${res.signed_out === 1 ? '' : 's'}.` : 'Password saved.',
      });
    } catch (err) {
      setResult({ ok: false, message: err.message });
    }
    setBusy(false);
  }

  return (
    <SectionCard
      title={user.has_password ? 'Password' : 'Set a password'}
      description={
        user.has_password
          ? 'Changing it signs you out on all other devices.'
          : 'You sign in with Google or LinkedIn. Add a password to also sign in with your email.'
      }
    >
      <form onSubmit={save} className="max-w-md space-y-4">
        {user.has_password && (
          <div>
            <label htmlFor="current" className="label">Current password</label>
            <PasswordInput id="current" value={current} onChange={setCurrent} autoComplete="current-password" />
          </div>
        )}
        <div>
          <label htmlFor="new" className="label">New password</label>
          <PasswordInput id="new" value={next} onChange={setNext} autoComplete="new-password" />
          <PasswordStrength password={next} />
        </div>
        <div>
          <label htmlFor="confirm" className="label">Confirm new password</label>
          <PasswordInput id="confirm" value={confirm} onChange={setConfirm} autoComplete="new-password" />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy || !next || (user.has_password && !current)}>
            {busy ? 'Saving…' : user.has_password ? 'Change password' : 'Set password'}
          </Button>
          <Result result={result} />
        </div>
      </form>
    </SectionCard>
  );
}

function SignInMethods({ notice }) {
  const { user, setUser } = useAuth();
  const providers = useProviders();
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(notice);

  async function unlink(provider) {
    setBusy(provider);
    setResult(null);
    try {
      const { user: updated } = await api(`/auth/providers/${provider}`, { method: 'DELETE' });
      setUser(updated);
      setResult({ ok: true, message: `${PROVIDER_META[provider].label} unlinked.` });
    } catch (err) {
      setResult({ ok: false, message: err.message });
    }
    setBusy(null);
  }

  const rows = [
    {
      key: 'email',
      icon: (
        <span className="grid size-5 place-items-center rounded bg-zinc-200 text-[11px] font-bold text-zinc-600">@</span>
      ),
      label: 'Email and password',
      linked: user.has_password,
      detail: user.has_password ? user.email : 'Not set: add a password above',
    },
    ...['google', 'linkedin'].map((p) => ({
      key: p,
      icon: PROVIDER_META[p].icon,
      label: PROVIDER_META[p].label,
      linked: user.providers.includes(p),
      available: providers?.[p],
    })),
  ];

  return (
    <SectionCard title="Sign-in methods" description="Ways you can sign in to this account.">
      <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200">
        {rows.map((row) => (
          <li key={row.key} className="flex flex-wrap items-center gap-3 px-4 py-3">
            {row.icon}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-zinc-900">{row.label}</div>
              <div className="truncate text-xs text-zinc-500">{row.detail || (row.linked ? 'Linked' : row.available ? 'Not linked' : 'Not available')}</div>
            </div>
            {row.key !== 'email' &&
              (row.linked ? (
                <Button variant="secondary" onClick={() => unlink(row.key)} disabled={busy !== null}>
                  {busy === row.key ? 'Unlinking…' : 'Unlink'}
                </Button>
              ) : row.available ? (
                <a
                  href={`/api/auth/${row.key}/start?mode=link`}
                  className="inline-flex items-center rounded-md border border-zinc-300 bg-surface px-3 py-1.5 text-sm font-medium text-zinc-800 shadow-sm hover:bg-zinc-50"
                >
                  Link
                </a>
              ) : null)}
          </li>
        ))}
      </ul>
      {result && (
        <p className="mt-3">
          <Result result={result} />
        </p>
      )}
    </SectionCard>
  );
}

function Sessions() {
  const [count, setCount] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    api('/auth/security').then((s) => setCount(s.sessions)).catch(() => {});
  }, []);

  async function signOutOthers() {
    setBusy(true);
    try {
      const { signed_out } = await api('/auth/logout-others', { method: 'POST' });
      setCount(1);
      setResult({ ok: true, message: `Signed out ${signed_out} other session${signed_out === 1 ? '' : 's'}.` });
    } catch (err) {
      setResult({ ok: false, message: err.message });
    }
    setBusy(false);
  }

  return (
    <SectionCard title="Sessions" description="Devices and browsers where you're signed in.">
      <p className="text-sm text-zinc-700">
        {count === null ? 'Loading…' : `You're signed in on ${count} device${count === 1 ? '' : 's'} (including this one).`}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={signOutOthers} disabled={busy || count === null || count <= 1}>
          {busy ? 'Signing out…' : 'Sign out all other devices'}
        </Button>
        <Result result={result} />
      </div>
    </SectionCard>
  );
}

function DangerZone() {
  const router = useRouter();
  const { user, setUser } = useAuth();
  const [open, setOpen] = useState(false);
  const [confirmValue, setConfirmValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function remove(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/auth/me', {
        method: 'DELETE',
        body: user.has_password ? { password: confirmValue } : { email: confirmValue },
      });
      setUser(null);
      router.replace('/signup');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <SectionCard
      tone="danger"
      title="Delete account"
      description="Permanently deletes your account, Brand Brain, posts, calendar and connected accounts. This can't be undone."
    >
      {!open ? (
        <Button variant="secondary" className="text-red-600" onClick={() => setOpen(true)}>
          Delete my account…
        </Button>
      ) : (
        <form onSubmit={remove} className="max-w-md space-y-3">
          <label htmlFor="confirm-delete" className="label">
            {user.has_password ? 'Enter your password to confirm' : `Type ${user.email} to confirm`}
          </label>
          {user.has_password ? (
            <PasswordInput id="confirm-delete" value={confirmValue} onChange={setConfirmValue} autoComplete="current-password" />
          ) : (
            <input id="confirm-delete" className="input" value={confirmValue} onChange={(e) => setConfirmValue(e.target.value)} />
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || !confirmValue}
              className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-red-700 disabled:opacity-50"
            >
              {busy ? 'Deleting…' : 'Delete permanently'}
            </button>
            <Button variant="ghost" type="button" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </SectionCard>
  );
}

export default function AccountPage() {
  const [notice, setNotice] = useState(null);

  // Back from linking Google/LinkedIn.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('linked')) setNotice({ ok: true, message: `${PROVIDER_META[params.get('linked')]?.label || 'Account'} linked.` });
    if (params.get('error')) setNotice({ ok: false, message: params.get('error') });
    if (params.size) window.history.replaceState(null, '', '/account');
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader title="Account" description="Your profile, sign-in methods and security." />
      <Profile />
      <Password />
      <SignInMethods key={notice?.message || 'methods'} notice={notice} />
      <Sessions />
      <DangerZone />
    </div>
  );
}
