'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, PLATFORMS } from '@/lib/api';
import { UserAvatar } from '@/components/auth';
import { Button, Card, ErrorText, PageHeader } from '@/components/ui';

const DAY_MS = 86_400_000;

function formatDate(iso) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
}

function timeAgo(iso) {
  if (!iso) return 'Never';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / DAY_MS);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  return formatDate(iso);
}

function Pill({ tone, children }) {
  const tones = {
    accent: 'bg-accent-100 text-accent-800',
    emerald: 'bg-emerald-100 text-emerald-800',
    amber: 'bg-amber-100 text-amber-800',
    red: 'bg-red-100 text-red-800',
    zinc: 'bg-zinc-100 text-zinc-600',
  };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

function Stat({ label, value }) {
  return (
    <Card>
      <div className="font-serif text-3xl font-semibold tabular-nums text-zinc-900">{value}</div>
      <div className="mt-0.5 text-sm text-zinc-500">{label}</div>
    </Card>
  );
}

function UserRow({ user, onChange, onRemove }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  async function update(label, body) {
    setBusy(label);
    setError('');
    try {
      onChange(await api(`/admin/users/${user.id}`, { method: 'PATCH', body }));
    } catch (err) {
      setError(err.message);
    }
    setBusy(null);
  }

  async function remove() {
    if (!window.confirm(`Delete ${user.email} and all of their posts, calendar and connections? This can't be undone.`)) return;
    setBusy('delete');
    try {
      await api(`/admin/users/${user.id}`, { method: 'DELETE' });
      onRemove(user.id);
    } catch (err) {
      setError(err.message);
      setBusy(null);
    }
  }

  return (
    <tr className="align-top">
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <UserAvatar user={user} />
          <div className="min-w-0">
            <div className="truncate font-medium text-zinc-900">{user.name}</div>
            <div className="truncate text-xs text-zinc-500">{user.email}</div>
            {error && <div className="mt-1 text-xs text-red-600">{error}</div>}
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1">
          {user.role === 'admin' && <Pill tone="accent">Admin</Pill>}
          {user.disabled ? <Pill tone="red">Disabled</Pill> : user.email_verified ? <Pill tone="emerald">Active</Pill> : <Pill tone="amber">Unverified</Pill>}
        </div>
        <div className="mt-1 text-xs text-zinc-500">{user.sign_in.join(', ') || '—'}</div>
      </td>
      <td className="px-4 py-3 text-sm tabular-nums text-zinc-700">
        {user.posts} post{user.posts === 1 ? '' : 's'} · {user.ai_calls} AI call{user.ai_calls === 1 ? '' : 's'}
        <div className="text-xs text-zinc-500">
          {user.platforms.length ? user.platforms.map((p) => PLATFORMS[p]?.label || p).join(', ') : 'No channels'}
        </div>
      </td>
      <td className="px-4 py-3 text-sm text-zinc-700">
        {formatDate(user.created_at)}
        <div className="text-xs text-zinc-500">Last sign-in: {timeAgo(user.last_login_at)}</div>
      </td>
      <td className="px-4 py-3">
        {user.is_self ? (
          <span className="text-xs text-zinc-400">You</span>
        ) : (
          <div className="flex flex-wrap justify-end gap-1">
            <Button variant="ghost" disabled={busy !== null} onClick={() => update('role', { role: user.role === 'admin' ? 'user' : 'admin' })}>
              {busy === 'role' ? '…' : user.role === 'admin' ? 'Remove admin' : 'Make admin'}
            </Button>
            <Button variant="ghost" disabled={busy !== null} onClick={() => update('disable', { disabled: !user.disabled })}>
              {busy === 'disable' ? '…' : user.disabled ? 'Enable' : 'Disable'}
            </Button>
            <Button variant="danger" disabled={busy !== null} onClick={remove}>
              {busy === 'delete' ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        )}
      </td>
    </tr>
  );
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState(null);
  const [me, setMe] = useState(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    Promise.all([api('/admin/users'), api('/auth/me')])
      .then(([list, { user }]) => {
        setMe(user.id);
        setUsers(list);
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(load, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (users || []).filter((u) => !q || u.email.includes(q) || u.name.toLowerCase().includes(q));
  }, [users, query]);

  if (error) return <ErrorText error={error} />;
  if (!users) return <p className="text-sm text-zinc-500">Loading…</p>;

  const weekAgo = Date.now() - 7 * DAY_MS;
  const stats = [
    ['Total users', users.length],
    ['Verified', users.filter((u) => u.email_verified).length],
    ['Active this week', users.filter((u) => u.last_login_at && new Date(u.last_login_at).getTime() > weekAgo).length],
    ['New this week', users.filter((u) => new Date(u.created_at).getTime() > weekAgo).length],
  ];
  const update = (updated) => setUsers((list) => list.map((u) => (u.id === updated.id ? updated : u)));
  const remove = (id) => setUsers((list) => list.filter((u) => u.id !== id));

  return (
    <div className="space-y-6">
      <PageHeader title="Users" description="Everyone who signed up. Each user has their own private workspace." />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map(([label, value]) => (
          <Stat key={label} label={label} value={value} />
        ))}
      </div>

      <Card className="overflow-hidden p-0!">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3">
          <h2 className="font-serif text-lg font-semibold text-zinc-900">All users</h2>
          <input
            type="search"
            className="input max-w-xs"
            placeholder="Search name or email"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left">
            <thead className="bg-zinc-50 text-xs font-semibold uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="px-4 py-2.5">User</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Usage</th>
                <th className="px-4 py-2.5">Joined</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200">
              {visible.map((user) => (
                <UserRow key={user.id} user={{ ...user, is_self: user.id === me }} onChange={update} onRemove={remove} />
              ))}
            </tbody>
          </table>
          {visible.length === 0 && <p className="py-10 text-center text-sm text-zinc-500">No users match “{query}”.</p>}
        </div>
      </Card>
    </div>
  );
}
