'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { addDays, api, formatDay, mondayOf, ymd } from '@/lib/api';
import { Button, Card, ErrorText, PageHeader, PlatformBadge, StatusBadge } from '@/components/ui';

export default function CalendarPage() {
  const [weekStart, setWeekStart] = useState(() => ymd(mondayOf(new Date())));
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [planning, setPlanning] = useState(false);
  const [drafting, setDrafting] = useState({});
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');

  const weekEnd = addDays(weekStart, 6);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const undrafted = items.filter((item) => !item.post_id);
  const busy = planning || Object.keys(drafting).length > 0;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api(`/calendar?from=${weekStart}&to=${addDays(weekStart, 6)}`));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [weekStart]);

  useEffect(() => {
    setError('');
    load();
  }, [load]);

  async function plan() {
    if (undrafted.length > 0 && !window.confirm('Replace the undrafted ideas for this week with a new plan?')) return;
    setPlanning(true);
    setError('');
    try {
      const planned = await api('/calendar/generate', { method: 'POST', body: { weekStart } });
      setItems(planned);
      toast.success(`Week planned: ${planned.length} post ideas`);
    } catch (err) {
      setError(err.message);
    } finally {
      setPlanning(false);
    }
  }

  async function draft(item) {
    setDrafting((d) => ({ ...d, [item.id]: true }));
    try {
      await api(`/calendar/${item.id}/draft`, { method: 'POST' });
    } finally {
      setDrafting(({ [item.id]: _, ...rest }) => rest);
    }
  }

  async function draftOne(item) {
    setError('');
    try {
      await draft(item);
      toast.success('Draft written', { description: 'Review it in Posts → Drafts.' });
    } catch (err) {
      setError(err.message);
    }
    load();
  }

  async function draftAll() {
    setError('');
    const queue = [...undrafted];
    let written = 0;
    for (let i = 0; i < queue.length; i++) {
      setProgress(`Writing draft ${i + 1} of ${queue.length}…`);
      try {
        await draft(queue[i]);
        written++;
      } catch (err) {
        setError(err.message);
        break;
      }
      await load();
    }
    setProgress('');
    if (written) toast.success(`${written} draft${written === 1 ? '' : 's'} written`, { description: 'Review them in Posts → Drafts.' });
    load();
  }

  async function remove(item) {
    setError('');
    try {
      await api(`/calendar/${item.id}`, { method: 'DELETE' });
      setItems((list) => list.filter((i) => i.id !== item.id));
      toast.success('Idea removed');
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Content calendar" description="The Strategist plans your week from your Brand Brain. Then turn ideas into drafts.">
        <Button onClick={plan} disabled={busy}>
          {planning ? 'Planning… (≈30s)' : items.length ? 'Replan week' : 'Plan this week'}
        </Button>
        {undrafted.length > 0 && (
          <Button variant="secondary" onClick={draftAll} disabled={busy}>
            Write all {undrafted.length} drafts
          </Button>
        )}
      </PageHeader>

      <div className="flex items-center gap-2">
        <Button variant="secondary" onClick={() => setWeekStart(addDays(weekStart, -7))} disabled={busy}>
          ←
        </Button>
        <span className="min-w-48 text-center text-sm font-medium">
          {formatDay(weekStart)} – {formatDay(weekEnd)}
        </span>
        <Button variant="secondary" onClick={() => setWeekStart(addDays(weekStart, 7))} disabled={busy}>
          →
        </Button>
        {weekStart !== ymd(mondayOf(new Date())) && (
          <Button variant="ghost" onClick={() => setWeekStart(ymd(mondayOf(new Date())))} disabled={busy}>
            This week
          </Button>
        )}
      </div>

      {progress && <p className="text-sm text-accent-700">{progress}</p>}
      <ErrorText error={error} />

      {loading && items.length === 0 ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : items.length === 0 ? (
        <Card className="py-10 text-center text-sm text-zinc-500">No plan for this week yet. Click “Plan this week”.</Card>
      ) : (
        <div className="space-y-5">
          {days.map((day) => {
            const dayItems = items.filter((item) => item.date === day);
            if (dayItems.length === 0) return null;
            return (
              <section key={day}>
                <h2 className="mb-2 text-sm font-semibold text-zinc-500">{formatDay(day)}</h2>
                <div className="grid gap-3 md:grid-cols-2">
                  {dayItems.map((item) => (
                    <Card key={item.id} className="flex flex-col gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <PlatformBadge platform={item.platform} />
                        <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">{item.format}</span>
                        <span className="text-xs text-zinc-500">{item.pillar}</span>
                      </div>
                      <p className="flex-1 text-sm">{item.hook_idea}</p>
                      <div className="flex items-center gap-2">
                        {item.post_id ? (
                          <>
                            <StatusBadge status={item.post_status} />
                            <Link href="/posts" className="text-sm text-accent-600 hover:underline">
                              Review in Posts →
                            </Link>
                          </>
                        ) : (
                          <>
                            <Button variant="secondary" onClick={() => draftOne(item)} disabled={busy}>
                              {drafting[item.id] ? 'Writing… (≈30s)' : 'Write draft'}
                            </Button>
                            <Button variant="danger" className="ml-auto" onClick={() => remove(item)} disabled={busy}>
                              Remove
                            </Button>
                          </>
                        )}
                      </div>
                    </Card>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
