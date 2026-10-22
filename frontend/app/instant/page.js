'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, PLATFORMS } from '@/lib/api';
import { Button, Card, ErrorText, ExpandAll, PageHeader } from '@/components/ui';
import PostCard from '@/components/PostCard';

const MEDIA = [
  {
    key: 'image',
    title: 'AI image',
    text: 'One on-brand image per post, sized for each platform.',
    time: '≈15 s each',
    icon: 'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M15.5 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
  },
  {
    key: 'video',
    title: 'AI video',
    text: 'A short clip per post; Instagram gets a Reel. Made in the background.',
    time: '1–3 min each',
    icon: 'M4 6h11v12H4zM15 10l5-3v10l-5-3',
  },
];

function MediaOption({ option, status, checked, onChange }) {
  const ready = status?.ready;
  return (
    <label
      className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition ${
        checked && ready ? 'border-accent-500 bg-accent-50' : 'border-zinc-200 hover:border-zinc-300'
      } ${ready === false ? 'cursor-not-allowed opacity-70' : ''}`}
    >
      <input type="checkbox" className="mt-1" checked={Boolean(checked && ready)} disabled={!ready} onChange={(e) => onChange(e.target.checked)} />
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface text-accent-700 ring-1 ring-zinc-200">
        <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d={option.icon} />
        </svg>
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2">
          <span className="text-sm font-medium text-zinc-900">{option.title}</span>
          <span className="text-xs text-zinc-500">{option.time}</span>
        </span>
        <span className="block text-xs text-zinc-600">{option.text}</span>
        {status && !ready && (
          <span className="mt-1 block text-xs text-amber-700">
            {status.missing}{' '}
            <Link href="/settings#ai" className="font-medium underline">
              Settings
            </Link>
          </span>
        )}
        {ready && <span className="mt-1 block truncate text-xs text-zinc-500">{status.label} · {status.model}</span>}
      </span>
    </label>
  );
}

export default function InstantPage() {
  const [topic, setTopic] = useState('');
  const [platforms, setPlatforms] = useState([]);
  const [media, setMedia] = useState({ image: false, video: false });
  const [providers, setProviders] = useState({});
  const [posts, setPosts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [expand, setExpand] = useState(null);

  useEffect(() => {
    api('/brand')
      .then((brand) => setPlatforms(brand.platforms))
      .catch(() => setPlatforms(Object.keys(PLATFORMS)));
    api('/status')
      .then((s) => {
        setProviders({ image: s.images, video: s.videos });
        setMedia((m) => ({ ...m, image: Boolean(s.images?.ready) }));
      })
      .catch(() => {});
  }, []);

  const toggle = (key) => setPlatforms((list) => (list.includes(key) ? list.filter((p) => p !== key) : [...list, key]));
  const update = useCallback((updated) => setPosts((list) => list.map((p) => (p.id === updated.id ? updated : p))), []);
  const remove = useCallback((id) => setPosts((list) => list.filter((p) => p.id !== id)), []);

  const wantImage = media.image && providers.image?.ready;
  const wantVideo = media.video && providers.video?.ready;
  const instagramWithoutMedia = platforms.includes('instagram') && !wantImage && !wantVideo;

  async function generate(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setProgress('Writing drafts…');
    const problems = [];
    try {
      const created = await api('/posts/instant', { method: 'POST', body: { topic, platforms } });
      setPosts((list) => [...created, ...list]);
      toast.success(`${created.length} draft${created.length === 1 ? '' : 's'} written`);

      // Images one at a time (free tiers rate-limit), each shown as soon as it's ready.
      if (wantImage) {
        for (const [i, post] of created.entries()) {
          setProgress(`Making image ${i + 1} of ${created.length} (${PLATFORMS[post.platform].label})…`);
          try {
            update(await api(`/posts/${post.id}/image/generate`, { method: 'POST', body: {} }));
          } catch (err) {
            problems.push(`${PLATFORMS[post.platform].label} image: ${err.message}`);
          }
        }
      }
      // Videos only need to be started; each card follows its own progress.
      if (wantVideo) {
        setProgress('Starting videos…');
        for (const post of created) {
          try {
            update(await api(`/posts/${post.id}/video/generate`, { method: 'POST', body: {} }));
          } catch (err) {
            problems.push(`${PLATFORMS[post.platform].label} video: ${err.message}`);
          }
        }
      }
    } catch (err) {
      problems.push(err.message);
    } finally {
      setError(problems.join('\n'));
      if (problems.length) toast.error(`${problems.length} problem${problems.length === 1 ? '' : 's'}: see the details on the page`);
      setProgress('');
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Instant content"
        description="Skip the calendar: give a topic and get on-brand drafts for each platform right away, with AI images or videos."
      />

      <Card>
        <form onSubmit={generate} className="space-y-5">
          <div>
            <label htmlFor="topic" className="label">Topic or idea</label>
            <textarea
              id="topic"
              className="input"
              rows={4}
              placeholder="e.g. Why small businesses should answer every customer review, with a story about a café owner"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              required
            />
          </div>

          <div>
            <span className="label">Platforms</span>
            <div className="flex flex-wrap gap-2">
              {Object.entries(PLATFORMS).map(([key, p]) => (
                <label
                  key={key}
                  className={`flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition ${
                    platforms.includes(key) ? 'border-accent-500 bg-accent-50 text-accent-800' : 'border-zinc-200 text-zinc-700 hover:border-zinc-300'
                  }`}
                >
                  <input type="checkbox" checked={platforms.includes(key)} onChange={() => toggle(key)} />
                  {p.label}
                </label>
              ))}
            </div>
          </div>

          <div>
            <span className="label">Add media</span>
            <div className="grid gap-3 md:grid-cols-2">
              {MEDIA.map((option) => (
                <MediaOption
                  key={option.key}
                  option={option}
                  status={providers[option.key]}
                  checked={media[option.key]}
                  onChange={(on) => setMedia((m) => ({ ...m, [option.key]: on }))}
                />
              ))}
            </div>
            {instagramWithoutMedia && (
              <p className="mt-2 text-xs text-amber-700">Instagram needs an image or a video before it can be approved. Tick one above, or add it to the draft later.</p>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-zinc-200 pt-4">
            {progress && (
              <span className="mr-auto flex items-center gap-2 text-sm text-accent-700">
                <span className="size-4 animate-spin rounded-full border-2 border-accent-300 border-t-accent-600" />
                {progress}
              </span>
            )}
            <Button type="submit" className="py-2" disabled={busy || !topic.trim() || platforms.length === 0}>
              {busy ? 'Working…' : wantImage && wantVideo ? 'Generate drafts, images & videos' : wantImage ? 'Generate drafts & images' : wantVideo ? 'Generate drafts & videos' : 'Generate drafts'}
            </Button>
          </div>
        </form>
      </Card>

      {error && <ErrorText error={<span className="whitespace-pre-line">{error}</span>} />}

      {posts.length > 0 && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-zinc-500">These drafts are also in Posts → Drafts. Videos keep being made if you leave this page.</p>
            <ExpandAll onChange={setExpand} />
          </div>
          {posts.map((post) => (
            <PostCard key={post.id} post={post} onUpdate={update} onRemove={remove} defaultOpen={posts.length === 1} expand={expand} />
          ))}
        </div>
      )}
    </div>
  );
}
