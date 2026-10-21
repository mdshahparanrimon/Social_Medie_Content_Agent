'use client';

import Link from 'next/link';
import { Card } from '@/components/ui';

const TASK_LABELS = {
  creator: 'Writing drafts',
  critic: 'Brand review',
  strategist: 'Week planning',
  image: 'Images',
  'image-prompt': 'Image prompts',
  video: 'Videos',
  'video-prompt': 'Video prompts',
  'connection-test': 'Connection tests',
  other: 'Other',
};

const compact = (n) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
// Days arrive as UTC dates (YYYY-MM-DD); format them in UTC so they don't shift a day.
const dayLabel = (date, opts = { day: 'numeric', month: 'short' }) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });

function timeAgo(iso) {
  if (!iso) return 'No AI calls yet';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'Last call just now';
  if (minutes < 60) return `Last call ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Last call ${hours} h ago`;
  const days = Math.round(hours / 24);
  return `Last call ${days} day${days === 1 ? '' : 's'} ago`;
}

function ProviderChip({ label, ready, name, model, missing }) {
  return (
    <div
      className="flex min-w-0 items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs"
      title={ready ? `${name} · ${model}` : missing}
    >
      <span className={`size-2 shrink-0 rounded-full ${ready ? 'bg-emerald-500' : 'bg-amber-500'}`} />
      <span className="text-zinc-500">{label}</span>
      <span className="truncate font-medium text-zinc-900">{ready ? name : 'Not set up'}</span>
      {ready && model && <span className="hidden truncate font-mono text-zinc-500 sm:inline">{model}</span>}
    </div>
  );
}

function Kpi({ label, value, hint }) {
  return (
    <div className="rounded-lg border border-zinc-200 px-4 py-3">
      <div className="text-xs font-medium text-zinc-500">{label}</div>
      <div className="mt-1 font-serif text-2xl font-semibold tabular-nums text-zinc-900">{value}</div>
      <div className="truncate text-xs text-zinc-500">{hint}</div>
    </div>
  );
}

// Calls per day: one series, one hue. Each column is the hover target; the tooltip names day and value.
function DailyChart({ daily }) {
  if (daily.length === 0) return null;
  const max = Math.max(...daily.map((d) => d.calls), 1);
  const total = daily.reduce((sum, d) => sum + d.calls, 0);
  const last = daily.length - 1;
  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-zinc-900">Last {daily.length} days</h3>
        <span className="text-xs tabular-nums text-zinc-500">{total.toLocaleString()} calls</span>
      </div>
      <div className="relative">
        <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-zinc-200" />
        <span className="pointer-events-none absolute -top-2 right-0 bg-surface pl-1 text-[10px] tabular-nums text-zinc-400">{max}</span>
        <div className="flex h-32 items-end gap-0.5 border-b border-zinc-300 pt-3" role="img" aria-label={`AI calls per day over the last ${daily.length} days, ${total} in total`}>
          {daily.map((d, i) => (
            <div key={d.date} tabIndex={0} className="group relative flex h-full flex-1 items-end outline-none" aria-label={`${dayLabel(d.date)}: ${d.calls} calls`}>
              <div
                className={`w-full rounded-t-[4px] transition-opacity ${d.calls ? 'bg-accent-500' : 'bg-zinc-200'} ${i === last ? '' : 'group-hover:opacity-80'} group-focus-visible:ring-2 group-focus-visible:ring-accent-300`}
                style={{ height: d.calls ? `${Math.max((d.calls / max) * 100, 4)}%` : '2px' }}
              />
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-zinc-200 bg-surface px-2 py-1 text-xs shadow-lg group-hover:block group-focus-visible:block">
                <div className="text-zinc-500">{dayLabel(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}</div>
                <div className="font-semibold tabular-nums text-zinc-900">
                  {d.calls} call{d.calls === 1 ? '' : 's'}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-1.5 flex justify-between text-[10px] text-zinc-400">
          <span>{dayLabel(daily[0].date)}</span>
          <span>{dayLabel(daily[Math.floor(last / 2)].date)}</span>
          <span>Today</span>
        </div>
      </div>
      <table className="sr-only">
        <caption>AI calls per day</caption>
        <tbody>
          {daily.map((d) => (
            <tr key={d.date}>
              <th scope="row">{d.date}</th>
              <td>{d.calls}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ByTask({ rows, totalCalls }) {
  const top = rows.slice(0, 5);
  const max = Math.max(...top.map((r) => r.calls), 1);
  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold text-zinc-900">By task</h3>
      {top.length === 0 ? (
        <p className="text-sm text-zinc-500">Nothing yet. Write a draft to see where AI is used.</p>
      ) : (
        <ul className="space-y-3">
          {top.map((r) => (
            <li key={r.task} title={`${(r.input_tokens + r.output_tokens).toLocaleString()} tokens`}>
              <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                <span className="truncate text-zinc-700">{TASK_LABELS[r.task] || r.task}</span>
                <span className="shrink-0 tabular-nums text-zinc-500">
                  <span className="font-semibold text-zinc-900">{r.calls.toLocaleString()}</span> · {Math.round((r.calls / totalCalls) * 100)}%
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100">
                <div className="h-full rounded-full bg-accent-500" style={{ width: `${(r.calls / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The AI usage panel at the top of the Dashboard and Settings pages.
export default function AIUsage({ ai, images, videos, usage, manageHref }) {
  const today = usage.daily?.at(-1)?.calls ?? 0;
  const made = (task) => usage.by_task?.find((r) => r.task === task)?.calls ?? 0;
  const imageCalls = made('image');
  const videoCalls = made('video');
  const claude = ai.provider === 'anthropic';

  return (
    <Card className="p-0!">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-lg bg-accent-50 text-accent-700">
            <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />
            </svg>
          </span>
          <div>
            <h2 className="font-serif text-lg font-semibold leading-tight text-zinc-900">AI usage</h2>
            <p className="text-xs text-zinc-500">{timeAgo(usage.last_at)}</p>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ProviderChip label="Writing" ready={ai.ready} name={ai.label} model={ai.model} missing="Add an AI key in Settings → AI." />
          {images && <ProviderChip label="Images" ready={images.ready} name={images.label} model={images.model} missing={images.missing} />}
          {videos && <ProviderChip label="Video" ready={videos.ready} name={videos.label} model={videos.model} missing={videos.missing} />}
          {manageHref && (
            <Link href={manageHref} className="ml-1 text-sm font-medium text-accent-600 hover:underline dark:text-accent-700">
              Manage →
            </Link>
          )}
        </div>
      </div>

      <div className="grid gap-6 p-5 lg:grid-cols-12">
        <div className="grid grid-cols-2 gap-3 lg:col-span-4">
          <Kpi label="AI calls" value={compact(usage.calls)} hint={`${today.toLocaleString()} today`} />
          <Kpi
            label="Tokens"
            value={compact(usage.input_tokens + usage.output_tokens)}
            hint={`${compact(usage.input_tokens)} in · ${compact(usage.output_tokens)} out`}
          />
          <Kpi label="Media made" value={compact(imageCalls + videoCalls)} hint={`${imageCalls.toLocaleString()} images · ${videoCalls.toLocaleString()} videos`} />
          <Kpi
            label="Est. cost"
            value={`$${usage.cost_usd.toFixed(2)}`}
            hint={claude ? 'Claude, estimated' : 'Tracked for Claude only'}
          />
        </div>
        <div className="lg:col-span-5">
          <DailyChart daily={usage.daily || []} />
        </div>
        <div className="lg:col-span-3">
          <ByTask rows={usage.by_task || []} totalCalls={Math.max(usage.calls, 1)} />
        </div>
      </div>
    </Card>
  );
}
