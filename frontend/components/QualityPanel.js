'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui';

// What the content checks found for a post (rules, media, and the AI review when one ran), and the controls for a post
// whose publishing result is unknown. All numbers and wording come from the backend (quality/gate.js, publishing.js).

const STATUS = {
  ready: { label: 'Checks passed', tone: 'border-emerald-200 bg-emerald-50 text-emerald-900' },
  needs_human_review: { label: 'Needs your review', tone: 'border-amber-200 bg-amber-50 text-amber-900' },
  blocked: { label: 'Must be fixed before approving', tone: 'border-red-200 bg-red-50 text-red-900' },
};

function List({ title, items, tone }) {
  if (!items?.length) return null;
  return (
    <div className="mt-2">
      <p className={`text-xs font-semibold uppercase tracking-wide ${tone}`}>{title}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">
        {items.map((item, i) => (
          <li key={i}>{typeof item === 'string' ? item : item.message}</li>
        ))}
      </ul>
    </div>
  );
}

export function QualityPanel({ post, onUpdate }) {
  const [busy, setBusy] = useState(null);
  const q = post.quality;
  if (!q || !['draft', 'failed', 'approved'].includes(post.status)) return null;
  const status = STATUS[q.status] || STATUS.needs_human_review;
  const score = q.score?.total;
  const ai = q.review;

  async function recheck(aiReview) {
    setBusy(aiReview ? 'ai' : 'check');
    try {
      const result = await api(`/posts/${post.id}/quality/check`, { method: 'POST', body: { aiReview } });
      onUpdate(result.post);
      toast.success(aiReview ? 'AI review finished' : 'Checks re-run');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={`rounded-lg border p-3 text-sm ${status.tone}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">
          {status.label}
          <span className="ml-2 font-normal opacity-80">
            {score !== null && score !== undefined
              ? `Score ${score}/100 (guide: ${q.score.threshold})`
              : 'No overall score yet: it needs an AI review'}
          </span>
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => recheck(false)} disabled={busy !== null}>
            {busy === 'check' ? 'Checking…' : 'Re-check'}
          </Button>
          <Button variant="ghost" onClick={() => recheck(true)} disabled={busy !== null}>
            {busy === 'ai' ? 'Reviewing…' : 'Run AI review'}
          </Button>
        </div>
      </div>
      <List title="Fix these" items={q.blockers} tone="text-red-700" />
      <List title="Look at these before approving" items={q.needs_acknowledgement} tone="text-amber-700" />
      {q.revision_limit_reached && <p className="mt-2 font-medium">The revision limit was reached. Please review this draft yourself.</p>}
      {ai?.status === 'ok' && (
        <div className="mt-2">
          <p className="text-xs font-semibold uppercase tracking-wide opacity-80">
            AI review ({ai.provider}, {ai.model}): {ai.score}/100 {ai.pass ? 'passed' : 'did not pass'}
            {ai.independent === false ? ' · same model as the writer' : ''}
          </p>
          <List title="Critical" items={ai.critical_issues?.map((c) => `${c.issue} (“${c.evidence}”)`)} tone="text-red-700" />
          <List title="Suggested edits" items={ai.revision_instructions} tone="opacity-80" />
        </div>
      )}
      {ai && ai.status !== 'ok' && ai.status !== 'not_run' && <p className="mt-2 opacity-80">AI review: {ai.message}</p>}
      <details className="mt-2">
        <summary className="cursor-pointer text-xs font-medium opacity-80">
          Details ({q.warnings?.length || 0} notes, {q.human_checklist?.length || 0} things to look at yourself)
        </summary>
        <List title="Notes" items={q.warnings} tone="opacity-80" />
        <List title="Machines can't judge these. Look yourself" items={q.human_checklist} tone="opacity-80" />
        <p className="mt-2 text-xs opacity-70">
          Score parts: rules/media {q.score?.technical_total ?? '–'} · AI opinion {q.score?.subjective_total ?? '–'}. A score is a guide for editing, not a
          prediction of results, and never approves a post.
        </p>
      </details>
    </section>
  );
}

// A post whose publishing outcome is unknown: it may or may not be live. It is never retried automatically.
export function UncertainPanel({ post, onUpdate }) {
  const [busy, setBusy] = useState(null);
  if (post.status !== 'uncertain') return null;

  async function act(key, path, body, success) {
    setBusy(key);
    try {
      const updated = await api(`/posts/${post.id}/${path}`, { method: 'POST', body });
      onUpdate(updated);
      toast.success(typeof success === 'function' ? success(updated) : success);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-lg border border-orange-300 bg-orange-50 p-3 text-sm text-orange-950">
      <p className="font-semibold">This post may or may not be live</p>
      <p className="mt-1">{post.uncertain_reason || post.error}</p>
      <p className="mt-1 opacity-80">
        It will not be published again automatically, so it can&apos;t be posted twice. Open the account, look for it, then tell the app what you found.
        {post.reconcile_note ? ` Last automatic check: ${post.reconcile_note}` : ''}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" disabled={busy !== null} onClick={() => act('reconcile', 'reconcile', {}, (p) => (p.status === 'published' ? 'Found it: marked as published' : 'Still not found'))}>
          {busy === 'reconcile' ? 'Checking…' : 'Check the platform again'}
        </Button>
        <Button
          variant="secondary"
          disabled={busy !== null}
          onClick={() => {
            const url = window.prompt('It is live. Paste its link (optional):', '');
            if (url === null) return;
            act('published', 'resolve', { outcome: 'published', externalUrl: url.trim() || undefined }, 'Marked as published');
          }}
        >
          It was posted
        </Button>
        <Button
          variant="ghost"
          disabled={busy !== null}
          onClick={() => {
            if (window.confirm('You checked and it is NOT on the platform? The post goes back to Failed so you can publish it again.')) {
              act('not_published', 'resolve', { outcome: 'not_published' }, 'Marked as not posted');
            }
          }}
        >
          It was not posted
        </Button>
      </div>
    </section>
  );
}
