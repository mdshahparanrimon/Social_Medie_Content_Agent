'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, formatDateTime, PLATFORMS } from '@/lib/api';
import { Button, ButtonLink, Card, PlatformBadge } from '@/components/ui';
import { Icon } from '@/components/Nav';
import { useAuth } from '@/components/auth';
import AIUsage from '@/components/AIUsage';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function SectionTitle({ children, action }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 className="font-serif text-lg font-semibold text-zinc-900">{children}</h2>
      {action}
    </div>
  );
}

function MoreLink({ href, children }) {
  return (
    <Link href={href} className="text-sm font-medium text-accent-600 hover:underline dark:text-accent-700">
      {children} →
    </Link>
  );
}

const TILE_TONES = {
  accent: 'bg-accent-50 text-accent-700',
  amber: 'bg-amber-50 text-amber-700',
  emerald: 'bg-emerald-50 text-emerald-700',
  red: 'bg-red-50 text-red-700',
  zinc: 'bg-zinc-100 text-zinc-500',
};

function StatTile({ label, value, hint, href, icon, tone }) {
  return (
    <Link href={href} className="group">
      <Card className="h-full transition group-hover:border-accent-300 group-hover:shadow-md">
        <div className="flex items-start justify-between">
          <span className={`grid size-9 place-items-center rounded-lg ${TILE_TONES[tone]}`}>
            <Icon name={icon} />
          </span>
          <span className="text-xs text-zinc-400 transition group-hover:text-accent-600">View →</span>
        </div>
        <div className="mt-4 font-serif text-3xl font-semibold tabular-nums text-zinc-900">{value}</div>
        <div className="mt-0.5 text-sm font-medium text-zinc-700">{label}</div>
        <div className="text-xs text-zinc-500">{hint}</div>
      </Card>
    </Link>
  );
}

const PIPELINE = [
  { key: 'draft', label: 'Drafts', color: 'bg-amber-400' },
  { key: 'scheduled', label: 'Scheduled', color: 'bg-accent-500' },
  { key: 'published', label: 'Published', color: 'bg-emerald-500' },
  { key: 'failed', label: 'Failed', color: 'bg-red-500' },
];

function Pipeline({ values }) {
  const total = PIPELINE.reduce((sum, s) => sum + values[s.key], 0);
  return (
    <Card>
      <SectionTitle action={<span className="text-sm text-zinc-500">{total} posts total</span>}>Content pipeline</SectionTitle>
      <div className="flex h-3 overflow-hidden rounded-full bg-zinc-100">
        {total > 0 &&
          PIPELINE.map((s) =>
            values[s.key] ? (
              <div key={s.key} className={`${s.color} h-full`} style={{ width: `${(values[s.key] / total) * 100}%` }} title={`${s.label}: ${values[s.key]}`} />
            ) : null,
          )}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
        {PIPELINE.map((s) => (
          <div key={s.key} className="flex items-center gap-2 text-sm">
            <span className={`size-2.5 rounded-full ${s.color}`} />
            <span className="text-zinc-600">{s.label}</span>
            <span className="font-semibold tabular-nums text-zinc-900">{values[s.key]}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function DateBlock({ iso }) {
  const d = new Date(iso);
  return (
    <div className="w-12 shrink-0 overflow-hidden rounded-lg border border-zinc-200 text-center">
      <div className="bg-zinc-100 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
        {d.toLocaleDateString(undefined, { month: 'short' })}
      </div>
      <div className="py-1 font-serif text-lg font-semibold leading-none text-zinc-900">{d.getDate()}</div>
    </div>
  );
}

function NextUp({ upcoming }) {
  return (
    <Card className="lg:col-span-2">
      <SectionTitle action={<MoreLink href="/posts?tab=scheduled">All scheduled</MoreLink>}>Next up</SectionTitle>
      {upcoming.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 py-10 text-center">
          <p className="text-sm text-zinc-500">Nothing scheduled yet.</p>
          <ButtonLink href="/calendar" variant="secondary" className="mt-3">
            Plan your week
          </ButtonLink>
        </div>
      ) : (
        <ul className="-my-3 divide-y divide-zinc-200">
          {upcoming.map((post) => (
            <li key={post.id} className="flex items-center gap-4 py-3">
              <DateBlock iso={post.scheduled_at} />
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-2">
                  <PlatformBadge platform={post.platform} />
                  <span className="text-xs text-zinc-500">{formatDateTime(post.scheduled_at)}</span>
                </div>
                <p className="truncate text-sm text-zinc-800">{post.content}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function CheckItem({ ok, title, detail, href, cta }) {
  return (
    <li className="flex items-start gap-3">
      <span
        className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-bold ${
          ok ? 'bg-emerald-500 text-white' : 'border-2 border-zinc-300'
        }`}
      >
        {ok && '✓'}
      </span>
      <div className="min-w-0 flex-1 text-sm">
        <div className={ok ? 'text-zinc-500' : 'font-medium text-zinc-900'}>{title}</div>
        {detail && <div className="text-xs text-zinc-500">{detail}</div>}
      </div>
      {!ok && href && (
        <Link href={href} className="shrink-0 text-xs font-medium text-accent-600 hover:underline dark:text-accent-700">
          {cta}
        </Link>
      )}
    </li>
  );
}

function Setup({ status, anyLive, isAdmin }) {
  const { ai, brandMissing } = status;
  const items = [
    {
      ok: ai.ready,
      title: 'Connect an AI provider',
      detail: ai.ready ? `${ai.label} · ${ai.model}` : 'Add your API key to start writing',
      href: '/settings#ai',
      cta: 'Settings',
    },
    {
      ok: brandMissing.length === 0,
      title: 'Fill in your Brand Brain',
      detail: brandMissing.length ? `Missing: ${brandMissing.join(', ')}` : 'Voice, audience and pillars set',
      href: '/brand',
      cta: 'Open',
    },
    {
      ok: anyLive,
      title: 'Connect a social account',
      detail: anyLive ? 'Posts go live on connected channels' : 'Until then, posts are simulated',
      href: '/connections',
      cta: 'Connect',
    },
  ];
  const done = items.filter((i) => i.ok).length;
  return (
    <Card>
      <SectionTitle action={<span className="text-sm tabular-nums text-zinc-500">{done}/{items.length}</span>}>Setup</SectionTitle>
      <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-zinc-100">
        <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${(done / items.length) * 100}%` }} />
      </div>
      <ul className="space-y-3.5">
        {items.map((item) => (
          <CheckItem key={item.title} {...item} />
        ))}
      </ul>
    </Card>
  );
}

function channelState(p) {
  const daysLeft = p.expires_at ? Math.ceil((new Date(p.expires_at) - Date.now()) / 86_400_000) : null;
  if (p.expired || (daysLeft !== null && daysLeft <= 0)) return { dot: 'bg-red-500', text: 'Expired, reconnect', warn: true };
  if (p.live && daysLeft !== null && daysLeft <= 7) return { dot: 'bg-amber-500', text: `Reconnect within ${daysLeft} day${daysLeft === 1 ? '' : 's'}`, warn: true };
  if (p.live) return { dot: 'bg-emerald-500', text: p.account ? `Connected as ${p.account}` : 'Connected' };
  if (p.configured) return { dot: 'bg-zinc-400', text: 'Dry run: simulated' };
  return { dot: 'bg-zinc-300', text: 'Not connected, simulated', connect: true };
}

function Channels({ platforms }) {
  return (
    <Card>
      <SectionTitle action={<MoreLink href="/connections">Manage</MoreLink>}>Channels</SectionTitle>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Object.entries(platforms).map(([key, p]) => {
          const s = channelState(p);
          return (
            <div key={key} className="flex items-center gap-3 rounded-lg border border-zinc-200 px-3 py-2.5">
              <PlatformBadge platform={key} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-sm font-medium text-zinc-900">
                  <span className={`size-2 rounded-full ${s.dot}`} />
                  {PLATFORMS[key]?.label || key}
                </div>
                <div className={`truncate text-xs ${s.warn ? 'font-medium text-red-600' : 'text-zinc-500'}`}>{s.text}</div>
              </div>
              {(s.connect || s.warn) && (
                <Link href="/connections" className="shrink-0 text-xs font-medium text-accent-600 hover:underline dark:text-accent-700">
                  {s.warn ? 'Reconnect' : 'Connect'}
                </Link>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function Skeleton() {
  return (
    <div className="animate-pulse space-y-6">
      <div className="h-64 rounded-xl bg-zinc-200" />
      <div className="h-16 w-72 rounded-lg bg-zinc-200" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-36 rounded-xl bg-zinc-200" />
        ))}
      </div>
      <div className="h-28 rounded-xl bg-zinc-200" />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="h-64 rounded-xl bg-zinc-200 lg:col-span-2" />
        <div className="h-64 rounded-xl bg-zinc-200" />
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { isAdmin, user } = useAuth();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setError('');
    api('/status').then(setStatus).catch((err) => setError(err.message));
  }, []);

  useEffect(load, [load]);

  if (error)
    return (
      <Card className="mx-auto max-w-md py-10 text-center">
        <p className="font-serif text-lg font-semibold text-zinc-900">Couldn&apos;t load the dashboard</p>
        <p className="mt-1 text-sm text-red-600">{error}</p>
        <Button className="mt-4" onClick={load}>
          Try again
        </Button>
      </Card>
    );
  if (!status) return <Skeleton />;

  const { counts, platforms, usage, upcoming, ai, images } = status;
  const values = {
    draft: counts.draft || 0,
    scheduled: (counts.approved || 0) + (counts.publishing || 0),
    published: counts.published || 0,
    failed: counts.failed || 0,
  };
  const anyLive = Object.values(platforms).some((p) => p.live);
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div className="space-y-6">
      <AIUsage ai={ai} images={images} videos={status.videos} usage={usage} manageHref="/settings#ai" />

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-zinc-500">{today}</p>
          <h1 className="font-serif text-[28px] font-semibold tracking-tight text-zinc-900">
            {greeting()}
            {user?.name ? `, ${user.name.split(" ")[0]}` : ""}
          </h1>
          <p className="mt-1 text-sm text-zinc-500">Plan → draft → approve → publish. Nothing posts without your approval.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ButtonLink href="/calendar" variant="secondary">
            <Icon name="calendar" className="size-4" /> Plan this week
          </ButtonLink>
          <ButtonLink href="/instant">
            <Icon name="instant" className="size-4" /> Instant post
          </ButtonLink>
        </div>
      </div>

      {status.dryRun && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-300/60 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          <span className="font-semibold">Dry run is on.</span>
          <span>Publishing is simulated, nothing goes live.</span>
          <Link href="/settings" className="ml-auto font-medium underline">
            Change
          </Link>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Drafts to review" hint="Waiting for your approval" value={values.draft} href="/posts" icon="posts" tone="amber" />
        <StatTile label="Scheduled" hint="Approved and queued" value={values.scheduled} href="/posts?tab=scheduled" icon="calendar" tone="accent" />
        <StatTile label="Published" hint="Live on your channels" value={values.published} href="/posts?tab=published" icon="dashboard" tone="emerald" />
        <StatTile
          label="Failed"
          hint={values.failed ? 'Needs your attention' : 'All good'}
          value={values.failed}
          href="/posts?tab=failed"
          icon="alert"
          tone={values.failed ? 'red' : 'zinc'}
        />
      </div>

      <Pipeline values={values} />

      <div className="grid gap-4 lg:grid-cols-3">
        <NextUp upcoming={upcoming} />
        <Setup status={status} anyLive={anyLive} isAdmin={isAdmin} />
      </div>

      <Channels platforms={platforms} />
    </div>
  );
}
