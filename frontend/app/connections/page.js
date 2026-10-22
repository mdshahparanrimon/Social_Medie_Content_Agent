'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, apiUrl, PLATFORMS } from '@/lib/api';
import { Button, Card, ErrorText, PageHeader, PlatformBadge } from '@/components/ui';
import { useAuth } from '@/components/auth';
import { notify } from '@/lib/notify';

const NOTES = {
  x: 'Posts text, with the image or video when a post has one.',
  linkedin: 'Posts to your personal profile, with an image, video or PDF carousel. LinkedIn asks you to reconnect every 60 days.',
  meta: 'Posts to a Facebook Page (Meta does not allow posting to personal profiles), with the image or video when a post has one.',
  instagram: 'Needs a Professional (Creator or Business) account. Every post needs an image or a video. Stays connected automatically.',
  google_drive:
    'Read-only access to your Drive. Then paste Drive links of images, videos and PDFs (in a post, or via Claude) without making the files public. Google Slides links become PDF carousels.',
};

// Connections that aren't places to post: where post media comes from. `setup` is the Settings section to set them up in.
const FILE_SOURCES = { google_drive: { label: 'Google Drive', setup: 'signin', setupLabel: 'set up Google sign-in' } };

const labelOf = (key) => PLATFORMS[key]?.label || FILE_SOURCES[key]?.label || key;

function daysUntil(iso) {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

function Avatar({ account }) {
  if (account.avatar_url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={account.avatar_url} alt="" className="h-12 w-12 rounded-full object-cover" />;
  }
  return (
    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-200 text-lg font-semibold text-zinc-600">
      {account.name?.replace(/^@/, '')[0]?.toUpperCase() || '?'}
    </div>
  );
}

function PlatformCard({ platform, account, info, onChange }) {
  const { isAdmin } = useAuth();
  const [busy, setBusy] = useState(null);
  const label = labelOf(platform);
  const source = FILE_SOURCES[platform];
  const connect = () => {
    setBusy('connect');
    window.location.href = apiUrl(`/oauth/${platform}/start`);
  };

  async function run(kind) {
    setBusy(kind);
    try {
      if (kind === 'test') {
        const result = await api(`/accounts/${platform}/test`, { method: 'POST' });
        notify({ ...result, message: `${label}: ${result.message}` });
      } else {
        await api(`/oauth/${platform}/disconnect`, { method: 'POST' });
        notify({ ok: true, message: `${label} disconnected` });
        onChange();
      }
    } catch (err) {
      notify({ ok: false, message: err.message });
    }
    setBusy(null);
  }

  const days = account?.expires_at ? daysUntil(account.expires_at) : null;
  const expired = days !== null && days <= 0;

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        {source ? (
          <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">{label}</span>
        ) : (
          <PlatformBadge platform={platform} />
        )}
        {account && (
          <span className={`text-xs font-medium ${expired || account.status === 'error' ? 'text-red-600' : 'text-emerald-700'}`}>
            {expired ? 'Expired' : account.status === 'error' ? 'Needs attention' : 'Connected'}
          </span>
        )}
      </div>

      {account ? (
        <div className="flex items-center gap-3">
          <Avatar account={account} />
          <div className="min-w-0">
            <div className="truncate font-medium">{account.name}</div>
            {account.username && <div className="truncate text-sm text-zinc-500">@{account.username}</div>}
            {days !== null && (
              <div className={`text-xs ${days <= 7 ? 'font-medium text-red-600' : 'text-zinc-500'}`}>
                {expired ? 'Connection expired: reconnect' : `Connection valid for ${days} more day${days === 1 ? '' : 's'}`}
              </div>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-zinc-500">{NOTES[platform]}</p>
      )}

      {account?.last_error && <ErrorText error={account.last_error} />}

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
        {!account && info && !info.app_ready && !isAdmin ? (
          <p className="text-sm text-zinc-500">{label} isn&apos;t available yet. It will appear here once it&apos;s enabled.</p>
        ) : !account && info && !info.app_ready ? (
          <p className="text-sm">
            One-time setup needed:{' '}
            <Link href={`/settings#${source?.setup || platform}`} className="font-medium text-accent-600 hover:underline">
              {source?.setupLabel || `set up the ${label} app`} →
            </Link>
          </p>
        ) : !account ? (
          <Button onClick={connect} disabled={busy !== null} className="w-full py-2">
            {busy === 'connect' ? 'Opening…' : `Connect ${label}`}
          </Button>
        ) : (
          <>
            <Button variant={expired || days <= 7 ? 'primary' : 'secondary'} onClick={connect} disabled={busy !== null}>
              Reconnect
            </Button>
            <Button variant="secondary" onClick={() => run('test')} disabled={busy !== null || expired}>
              {busy === 'test' ? 'Testing…' : 'Test'}
            </Button>
            <Button variant="danger" className="ml-auto" onClick={() => run('disconnect')} disabled={busy !== null}>
              Disconnect
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}

// Shown after "Connect Facebook" when your account manages more than one Page.
function PagePicker({ onDone }) {
  const [pages, setPages] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/oauth/meta/pages').then(setPages).catch((err) => setError(err.message));
  }, []);

  async function choose(id) {
    try {
      const result = await api('/oauth/meta/pages', { method: 'POST', body: { id } });
      onDone(result.message);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Card className="space-y-3 border-accent-300">
      <h2 className="font-semibold">Which Facebook Page should the agent post to?</h2>
      {pages?.length === 0 && <p className="text-sm text-zinc-500">The choice expired. Click Connect Facebook again.</p>}
      <div className="flex flex-wrap gap-2">
        {(pages || []).map((page) => (
          <Button key={page.id} variant="secondary" onClick={() => choose(page.id)}>
            {page.name}
          </Button>
        ))}
      </div>
      <ErrorText error={error} />
    </Card>
  );
}

export default function ConnectionsPage() {
  const [accounts, setAccounts] = useState(null);
  const [info, setInfo] = useState({});
  const [choosePage, setChoosePage] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api('/accounts')
      .then(setAccounts)
      .catch((err) => setError(err.message));
    api('/oauth/info')
      .then(setInfo)
      .catch(() => {});
    api('/status')
      .then((s) => setDryRun(s.dryRun))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    // Coming back from a platform's login page.
    const params = new URLSearchParams(window.location.search);
    const platform = params.get('platform');
    if (platform) {
      const label = labelOf(platform);
      notify(
        params.get('error')
          ? { ok: false, message: `${label}: ${params.get('error')}` }
          : { ok: true, message: `${label}: ${params.get('message') || 'connected'}` },
        { id: `oauth-${platform}` },
      );
      setChoosePage(params.get('choose_page') === '1');
      window.history.replaceState(null, '', '/connections');
    }
  }, [load]);

  if (!accounts) return error ? <ErrorText error={error} /> : <p className="text-sm text-zinc-500">Loading…</p>;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Connections"
        description="Connect your accounts with one click: log in on the platform, allow access, done. Platforms you don't connect are simulated."
      />

      {dryRun && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Dry run is on: nothing is really posted, even on connected accounts. Turn it off in Settings → Publishing.
        </p>
      )}
      {choosePage && (
        <PagePicker
          onDone={(message) => {
            setChoosePage(false);
            notify({ ok: true, message: `Facebook: ${message}` });
            load();
          }}
        />
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {Object.keys(PLATFORMS).map((platform) => (
          <PlatformCard
            key={platform}
            platform={platform}
            account={accounts.find((a) => a.platform === platform)}
            info={info[platform]}
            onChange={load}
          />
        ))}
      </div>

      <div className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">Files</h2>
          <p className="text-sm text-zinc-500">Where post images, videos and PDFs come from. Nothing is posted here.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {Object.keys(FILE_SOURCES).map((key) => (
            <PlatformCard key={key} platform={key} account={accounts.find((a) => a.platform === key)} info={info[key]} onChange={load} />
          ))}
        </div>
      </div>
    </div>
  );
}
