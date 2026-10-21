'use client';

import { useEffect, useState } from 'react';
import { api, charCount, formatDateTime, PLATFORMS, toLocalInput } from '@/lib/api';
import { Button, Card, ErrorText, PlatformBadge, StatusBadge } from '@/components/ui';

// Any image -> a JPEG that Instagram accepts: aspect ratio between 4:5 and 1.91:1 (center-cropped), at most 1440px wide.
async function toPostJpeg(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('That file is not an image.'));
      image.src = url;
    });
    let [sx, sy, sw, sh] = [0, 0, img.naturalWidth, img.naturalHeight];
    if (sw / sh < 0.8) {
      const h = sw / 0.8;
      sy = (sh - h) / 2;
      sh = h;
    } else if (sw / sh > 1.91) {
      const w = sh * 1.91;
      sx = (sw - w) / 2;
      sw = w;
    }
    const scale = Math.min(1, 1440 / sw);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // transparent PNGs get a white background
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.9);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Make an image with AI from the post text, optionally steered by instructions. Replaces any current image.
function GenerateImage({ post, busy, run, hasImage }) {
  const [open, setOpen] = useState(false);
  const [instructions, setInstructions] = useState('');

  const generate = () =>
    run('generate', async () => {
      const updated = await api(`/posts/${post.id}/image/generate`, { method: 'POST', body: { instructions } });
      setInstructions('');
      setOpen(false);
      return updated;
    });

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)} disabled={busy !== null}>
        {hasImage ? 'New AI image' : 'Generate image with AI'}
      </Button>
    );
  }
  return (
    <div className="flex w-full flex-col gap-2 sm:flex-row">
      <input
        className="input"
        placeholder="Optional: what should it show? (e.g. flat illustration, our green colors, a coffee cup)"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && generate()}
        disabled={busy !== null}
      />
      <Button onClick={generate} disabled={busy !== null}>
        {busy === 'generate' ? 'Generating…' : 'Generate'}
      </Button>
      <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy !== null}>
        Cancel
      </Button>
    </div>
  );
}

function ImageField({ post, editable, busy, run }) {
  const [link, setLink] = useState('');
  const required = PLATFORMS[post.platform].needsImage;
  const canRemove = editable && (!required || post.status !== 'approved');

  const upload = (file) =>
    run('image', async () => api(`/posts/${post.id}/image`, { method: 'PUT', body: { dataUrl: await toPostJpeg(file) } }));
  const addLink = () =>
    run('image', async () => {
      const updated = await api(`/posts/${post.id}/image`, { method: 'PUT', body: { url: link.trim() } });
      setLink('');
      return updated;
    });
  const remove = () => run('image', () => api(`/posts/${post.id}/image`, { method: 'DELETE' }));

  if (post.image_url) {
    // Instagram and Facebook download the image by link; X and LinkedIn get it uploaded by this server, so local is fine there.
    const local = ['instagram', 'meta'].includes(post.platform) && /\/\/(localhost|127\.0\.0\.1)[:/]/.test(post.image_url);
    return (
      <div className="space-y-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={post.image_url} alt="" className="max-h-72 rounded-md border border-zinc-200" />
        {local && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            This image is stored on this computer, so {PLATFORMS[post.platform].label} can&apos;t download it. Set up Media in
            Settings and upload it again.
          </p>
        )}
        {post.image_prompt && (
          <details className="text-xs text-zinc-500">
            <summary className="cursor-pointer select-none">Image prompt (made with AI)</summary>
            <p className="mt-1 whitespace-pre-wrap">{post.image_prompt}</p>
          </details>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {editable && <GenerateImage post={post} busy={busy} run={run} hasImage />}
          {canRemove && (
            <Button variant="ghost" onClick={remove} disabled={busy !== null}>
              Remove image
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (!editable) return null;
  return (
    <div className={`space-y-2 rounded-md border border-dashed p-3 ${required ? 'border-fuchsia-300 bg-fuchsia-50/40' : 'border-zinc-300'}`}>
      <p className="text-xs text-zinc-600">
        {required
          ? 'Instagram needs an image or a video. Images are cropped to Instagram size automatically.'
          : 'Optional: add an image to post it as a photo with this caption.'}
      </p>
      <GenerateImage post={post} busy={busy} run={run} />
      <div className="flex flex-wrap items-center gap-2">
        <label className={`inline-flex cursor-pointer items-center rounded-md bg-surface px-3 py-1.5 text-sm font-medium shadow-sm ring-1 ring-zinc-300 hover:bg-zinc-50 ${busy !== null ? 'pointer-events-none opacity-50' : ''}`}>
          {busy === 'image' ? 'Uploading…' : 'Upload image'}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              if (e.target.files[0]) upload(e.target.files[0]);
              e.target.value = '';
            }}
          />
        </label>
        <span className="text-xs text-zinc-400">or</span>
        <input
          className="input w-auto flex-1"
          placeholder="Paste an image link (https://…)"
          value={link}
          onChange={(e) => setLink(e.target.value)}
        />
        <Button variant="secondary" onClick={addLink} disabled={!link.trim() || busy !== null}>
          Add
        </Button>
      </div>
    </div>
  );
}

function Elapsed({ since }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - new Date(since || now).getTime()) / 1000));
  return <span className="tabular-nums">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span>;
}

// A short AI video. It takes minutes, so the server makes it in the background and the card polls the post.
function VideoField({ post, editable, busy, run }) {
  const [open, setOpen] = useState(false);
  const [instructions, setInstructions] = useState('');
  const label = PLATFORMS[post.platform].label;

  const start = () =>
    run('video', async () => {
      const updated = await api(`/posts/${post.id}/video/generate`, { method: 'POST', body: { instructions } });
      setInstructions('');
      setOpen(false);
      return updated;
    });
  const remove = () => run('video', () => api(`/posts/${post.id}/video`, { method: 'DELETE' }));

  if (post.video_status === 'generating') {
    return (
      <div className="flex items-center gap-3 rounded-md border border-accent-100 bg-accent-50 px-3 py-2.5 text-sm text-accent-800">
        <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-accent-300 border-t-accent-600" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">
            Making the video… <Elapsed since={post.video_started_at} />
          </div>
          <div className="text-xs opacity-80">Usually 1–3 minutes. It keeps going if you leave this page.</div>
        </div>
      </div>
    );
  }

  const form = open ? (
    <div className="flex w-full flex-col gap-2 sm:flex-row">
      <input
        className="input"
        placeholder="Optional: what should happen? (e.g. slow pan over a busy café, warm morning light)"
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && start()}
        disabled={busy !== null}
      />
      <Button onClick={start} disabled={busy !== null}>
        {busy === 'video' ? 'Starting…' : 'Generate video'}
      </Button>
      <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy !== null}>
        Cancel
      </Button>
    </div>
  ) : (
    <Button variant="secondary" onClick={() => setOpen(true)} disabled={busy !== null}>
      {post.video_url ? 'New AI video' : post.video_status === 'failed' ? 'Try again' : 'Generate video with AI'}
    </Button>
  );

  if (post.video_url) {
    const local = post.platform === 'instagram' && /\/\/(localhost|127\.0\.0\.1)[:/]/.test(post.video_url);
    return (
      <div className="space-y-2">
        {post.video_status === 'failed' && post.video_error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">The new video could not be made, so the earlier one is kept: {post.video_error}</p>
        )}
        <video src={post.video_url} controls playsInline preload="metadata" className="max-h-80 rounded-md border border-zinc-200 bg-black" />
        {post.image_url && <p className="text-xs text-zinc-500">This post goes out as a video; the image is only used if you remove the video.</p>}
        {local && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            This video is stored on this computer, so Instagram can&apos;t download it. Set up Media in Settings and generate it again.
          </p>
        )}
        {post.video_prompt && (
          <details className="text-xs text-zinc-500">
            <summary className="cursor-pointer select-none">Video prompt (made with AI)</summary>
            <p className="mt-1 whitespace-pre-wrap">{post.video_prompt}</p>
          </details>
        )}
        {editable && (
          <div className="flex flex-wrap items-center gap-2">
            {form}
            {!open && (
              <Button variant="ghost" onClick={remove} disabled={busy !== null}>
                Remove video
              </Button>
            )}
          </div>
        )}
      </div>
    );
  }

  if (!editable) return null;
  return (
    <div className="space-y-2 rounded-md border border-dashed border-zinc-300 p-3">
      {post.video_status === 'failed' && post.video_error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">The video could not be made: {post.video_error}</p>
      )}
      <p className="text-xs text-zinc-600">
        Optional: add a short AI video. The post then goes out as a {post.platform === 'instagram' ? 'Reel' : `${label} video`}.
      </p>
      {form}
    </div>
  );
}

export default function PostCard({ post, onUpdate, onRemove }) {
  const [content, setContent] = useState(post.content);
  const [when, setWhen] = useState(post.scheduled_at ? toLocalInput(post.scheduled_at) : '');
  const [feedback, setFeedback] = useState('');
  const [showRewrite, setShowRewrite] = useState(false);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => setContent(post.content), [post.content]);
  useEffect(() => setWhen(post.scheduled_at ? toLocalInput(post.scheduled_at) : ''), [post.scheduled_at]);

  const editable = ['draft', 'approved', 'failed'].includes(post.status);
  const dirty = content !== post.content;
  const count = charCount(post.platform, content);
  const { maxChars } = PLATFORMS[post.platform];
  const tooLong = count > maxChars;
  const missingImage = PLATFORMS[post.platform].needsImage && !post.image_url && !post.video_url;
  const videoPending = post.video_status === 'generating';
  const blocked = tooLong || missingImage || videoPending;

  // While the server makes the video, check the post every few seconds.
  useEffect(() => {
    if (!videoPending) return;
    const timer = setInterval(() => {
      api(`/posts/${post.id}`)
        .then((latest) => latest.video_status !== 'generating' && onUpdate(latest))
        .catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [videoPending, post.id, onUpdate]);

  async function run(label, action) {
    setBusy(label);
    setError('');
    try {
      const updated = await action();
      if (updated) onUpdate(updated);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  const save = () => run('save', () => api(`/posts/${post.id}`, { method: 'PATCH', body: { content } }));

  const approve = () =>
    run('approve', () =>
      api(`/posts/${post.id}/approve`, {
        method: 'POST',
        body: { content, scheduledAt: when ? new Date(when).toISOString() : undefined },
      }),
    );

  const unapprove = () => run('unapprove', () => api(`/posts/${post.id}/unapprove`, { method: 'POST' }));

  const rewrite = () =>
    run('rewrite', async () => {
      const updated = await api(`/posts/${post.id}/rewrite`, { method: 'POST', body: { feedback } });
      setFeedback('');
      setShowRewrite(false);
      return updated;
    });

  const publishNow = () => {
    if (!window.confirm(`Publish this post to ${PLATFORMS[post.platform].label} now?`)) return;
    run('publish', async () => {
      if (dirty) await api(`/posts/${post.id}`, { method: 'PATCH', body: { content } });
      return api(`/posts/${post.id}/publish`, { method: 'POST' });
    });
  };

  const remove = () => {
    if (!window.confirm('Delete this post?')) return;
    run('delete', async () => {
      await api(`/posts/${post.id}`, { method: 'DELETE' });
      onRemove(post.id);
    });
  };

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <PlatformBadge platform={post.platform} />
        <StatusBadge status={post.status} simulated={post.simulated} />
        {post.brand_score != null && (
          <span
            className={`text-xs font-medium ${post.brand_score >= 8 ? 'text-emerald-700' : 'text-amber-700'}`}
            title="Self-review score against your Brand Brain"
          >
            On-brand score {post.brand_score}/10
          </span>
        )}
        {post.status === 'approved' && post.scheduled_at && (
          <span className="text-xs text-zinc-500">Posts {formatDateTime(post.scheduled_at)}</span>
        )}
        {post.status === 'published' && post.published_at && (
          <span className="text-xs text-zinc-500">Published {formatDateTime(post.published_at)}</span>
        )}
      </div>

      <details className="text-xs text-zinc-500">
        <summary className="cursor-pointer select-none">Brief</summary>
        <p className="mt-1 whitespace-pre-wrap">{post.brief}</p>
      </details>

      <div>
        <textarea
          className="input min-h-36 font-[inherit] leading-relaxed"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          disabled={!editable || busy !== null}
          rows={Math.min(Math.max(content.split('\n').length + 1, 5), 16)}
        />
        <div className={`mt-1 text-right text-xs ${tooLong ? 'font-semibold text-red-600' : 'text-zinc-400'}`}>
          {count} / {maxChars}
        </div>
      </div>

      <ImageField post={post} editable={editable} busy={busy} run={run} />
      <VideoField post={post} editable={editable} busy={busy} run={run} />

      {post.critique && post.status === 'draft' && (
        <details className="text-xs text-zinc-600">
          <summary className="cursor-pointer select-none">Editor notes</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {post.critique.split('\n').map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </details>
      )}

      {post.error && <ErrorText error={post.error} />}
      <ErrorText error={error} />

      {showRewrite && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className="input"
            placeholder="What should change? (optional, e.g. shorter, more personal, add a question)"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && rewrite()}
          />
          <Button onClick={rewrite} disabled={busy !== null}>
            {busy === 'rewrite' ? 'Rewriting…' : 'Rewrite'}
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-3">
        {(post.status === 'draft' || post.status === 'failed') && (
          <>
            <input
              type="datetime-local"
              className="input w-auto"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              title="Leave empty to use the platform's default posting time"
            />
            <Button onClick={approve} disabled={busy !== null || blocked} title={videoPending ? 'Wait for the video to finish' : missingImage ? 'Add an image or a video first' : undefined}>
              {busy === 'approve' ? 'Approving…' : when ? 'Approve & schedule' : 'Approve (default time)'}
            </Button>
          </>
        )}
        {post.status === 'draft' && (
          <Button variant="secondary" onClick={() => setShowRewrite((v) => !v)} disabled={busy !== null}>
            Rewrite with AI
          </Button>
        )}
        {(post.status === 'approved' || post.status === 'failed') && (
          <Button variant="secondary" onClick={publishNow} disabled={busy !== null || blocked}>
            {busy === 'publish' ? 'Publishing…' : 'Publish now'}
          </Button>
        )}
        {(post.status === 'approved' || post.status === 'failed') && (
          <Button variant="ghost" onClick={unapprove} disabled={busy !== null}>
            Back to draft
          </Button>
        )}
        {editable && dirty && (
          <Button variant="secondary" onClick={save} disabled={busy !== null || tooLong}>
            {busy === 'save' ? 'Saving…' : 'Save edits'}
          </Button>
        )}
        {post.external_url && (
          <a href={post.external_url} target="_blank" rel="noreferrer" className="text-sm text-accent-600 hover:underline">
            View post ↗
          </a>
        )}
        {editable && (
          <Button variant="danger" className="ml-auto" onClick={remove} disabled={busy !== null}>
            Delete
          </Button>
        )}
      </div>
    </Card>
  );
}
