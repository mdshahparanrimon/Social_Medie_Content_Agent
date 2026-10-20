'use client';

import { useEffect, useState } from 'react';
import { api, PLATFORMS } from '@/lib/api';
import { Button, Card, ErrorText, PageHeader } from '@/components/ui';
import PostCard from '@/components/PostCard';

export default function InstantPage() {
  const [topic, setTopic] = useState('');
  const [platforms, setPlatforms] = useState([]);
  const [posts, setPosts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/brand')
      .then((brand) => setPlatforms(brand.platforms))
      .catch(() => setPlatforms(Object.keys(PLATFORMS)));
  }, []);

  const toggle = (key) =>
    setPlatforms((list) => (list.includes(key) ? list.filter((p) => p !== key) : [...list, key]));

  async function generate(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const created = await api('/posts/instant', { method: 'POST', body: { topic, platforms } });
      setPosts((list) => [...created, ...list]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Instant content"
        description="Skip the calendar: give a topic and get on-brand drafts for each platform right away."
      />

      <Card>
        <form onSubmit={generate} className="space-y-4">
          <div>
            <label className="label">Topic or idea</label>
            <textarea
              className="input"
              rows={4}
              placeholder="e.g. Why small businesses should answer every customer review, with a story about a café owner"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              required
            />
          </div>
          <div className="flex flex-wrap items-center gap-4">
            {Object.entries(PLATFORMS).map(([key, p]) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={platforms.includes(key)} onChange={() => toggle(key)} />
                {p.label}
              </label>
            ))}
            <Button type="submit" className="ml-auto" disabled={busy || !topic.trim() || platforms.length === 0}>
              {busy ? 'Writing… (≈30–60s)' : 'Generate drafts'}
            </Button>
          </div>
        </form>
      </Card>

      <ErrorText error={error} />

      {posts.length > 0 && (
        <div className="space-y-4">
          <p className="text-sm text-zinc-500">These drafts are also in Posts → Drafts.</p>
          {posts.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              onUpdate={(updated) => setPosts((list) => list.map((p) => (p.id === updated.id ? updated : p)))}
              onRemove={(id) => setPosts((list) => list.filter((p) => p.id !== id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
