'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { Card, ErrorText, PageHeader } from '@/components/ui';
import PostCard from '@/components/PostCard';

const TABS = [
  { key: 'drafts', label: 'Drafts', statuses: ['draft'] },
  { key: 'scheduled', label: 'Scheduled', statuses: ['approved', 'publishing'] },
  { key: 'published', label: 'Published', statuses: ['published'] },
  { key: 'failed', label: 'Failed', statuses: ['failed'] },
];

function PostsView() {
  const router = useRouter();
  const tabKey = useSearchParams().get('tab') || 'drafts';
  const tab = TABS.find((t) => t.key === tabKey) || TABS[0];
  const [posts, setPosts] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/posts').then(setPosts).catch((err) => setError(err.message));
  }, []);

  if (error) return <ErrorText error={error} />;
  if (!posts) return <p className="text-sm text-zinc-500">Loading…</p>;

  const update = (updated) => setPosts((list) => list.map((p) => (p.id === updated.id ? updated : p)));
  const remove = (id) => setPosts((list) => list.filter((p) => p.id !== id));
  const visible = posts
    .filter((p) => tab.statuses.includes(p.status))
    .sort((a, b) =>
      tab.key === 'published'
        ? b.published_at.localeCompare(a.published_at)
        : (a.scheduled_at || a.created_at).localeCompare(b.scheduled_at || b.created_at),
    );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Posts"
        description="Review every draft: edit, rewrite, then approve. Approved posts go out automatically at their scheduled time."
      />

      <div className="flex flex-wrap gap-1 border-b border-zinc-200">
        {TABS.map((t) => {
          const count = posts.filter((p) => t.statuses.includes(p.status)).length;
          return (
            <button
              key={t.key}
              onClick={() => router.replace(`/posts?tab=${t.key}`)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
                t.key === tab.key ? 'border-accent-600 text-accent-700' : 'border-transparent text-zinc-500 hover:text-zinc-800'
              }`}
            >
              {t.label} <span className="text-zinc-400">{count}</span>
            </button>
          );
        })}
      </div>

      {visible.length === 0 ? (
        <Card className="py-10 text-center text-sm text-zinc-500">Nothing here.</Card>
      ) : (
        <div className="space-y-4">
          {visible.map((post) => (
            <PostCard key={post.id} post={post} onUpdate={update} onRemove={remove} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function PostsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
      <PostsView />
    </Suspense>
  );
}
