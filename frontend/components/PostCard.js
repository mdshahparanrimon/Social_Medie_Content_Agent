'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, charCount, formatDateTime, PLATFORMS, toLocalInput } from '@/lib/api';
import { Button, Card, ErrorText, Icon, PlatformIcon, StatusBadge } from '@/components/ui';

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

// Toast text per action: [while running, when done]. "done" may be a function of the updated post.
const TOASTS = {
  save: ['Saving…', 'Edits saved'],
  approve: ['Scheduling…', (p) => `Scheduled for ${formatDateTime(p.scheduled_at)}`],
  unapprove: ['Moving back to draft…', 'Moved back to draft'],
  rewrite: ['Rewriting with AI…', 'New version written'],
  publish: ['Publishing…', 'Published'],
  delete: ['Deleting…', 'Post deleted'],
  'image-generate': ['Generating the image…', 'Image ready'],
  'image-upload': ['Uploading the image…', 'Image added'],
  'image-link': ['Downloading the image…', 'Image added'],
  'image-remove': ['Removing the image…', 'Image removed'],
  'video-generate': ['Starting the video…', 'Video started. It takes 1–3 minutes; you can leave this page.'],
  'video-upload': ['Uploading the video…', 'Video added'],
  'video-link': ['Downloading the video…', 'Video added'],
  'video-remove': ['Removing the video…', 'Video removed'],
  'document-generate': ['Writing and designing the slides…', (p) => `Carousel ready: ${p.document_pages} slides`],
  'document-upload': ['Uploading the PDF…', 'PDF carousel added'],
  'document-link': ['Downloading the PDF…', 'PDF carousel added'],
  'document-remove': ['Removing the carousel…', 'Carousel removed'],
};

const fileButtonClass = (busy) =>
  `inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md border border-zinc-300 bg-surface px-3 py-1.5 text-sm font-medium text-zinc-800 shadow-sm transition hover:bg-zinc-50 ${
    busy !== null ? 'pointer-events-none opacity-50' : ''
  }`;

function FileButton({ label, accept, onFile, busy }) {
  return (
    <label className={fileButtonClass(busy)}>
      <Icon name="upload" />
      {label}
      <input
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          if (e.target.files[0]) onFile(e.target.files[0]);
          e.target.value = '';
        }}
      />
    </label>
  );
}

// Paste a public link (Google Drive share links work); the server downloads the file and stores it like an upload.
function LinkInput({ noun, busy, busyLabel, onAdd }) {
  const [link, setLink] = useState('');
  const add = async () => {
    if (await onAdd(link.trim())) setLink('');
  };
  return (
    <div className="flex w-full flex-col gap-2 sm:flex-row">
      <div className="relative flex-1">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-zinc-400">
          <Icon name="link" />
        </span>
        <input
          className="input pl-9"
          placeholder={`Paste a ${noun} link: https://… or Google Drive`}
          value={link}
          onChange={(e) => setLink(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && link.trim() && add()}
          disabled={busy !== null}
        />
      </div>
      <Button variant="secondary" onClick={add} disabled={!link.trim() || busy !== null}>
        {busy === busyLabel ? 'Adding…' : 'Add link'}
      </Button>
    </div>
  );
}

// "Write instructions, then generate" form for AI media; the trigger button shows until it's opened.
function AiForm({ label, placeholder, busy, busyLabel, busyText, onGenerate }) {
  const [open, setOpen] = useState(false);
  const [instructions, setInstructions] = useState('');
  const generate = async () => {
    if (await onGenerate(instructions)) {
      setInstructions('');
      setOpen(false);
    }
  };
  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)} disabled={busy !== null}>
        <Icon name="sparkles" className="size-4 text-accent-600" />
        {label}
      </Button>
    );
  }
  return (
    <div className="flex w-full flex-col gap-2 rounded-lg border border-accent-100 bg-accent-50 p-2 sm:flex-row">
      <input
        className="input"
        placeholder={placeholder}
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && generate()}
        disabled={busy !== null}
        autoFocus
      />
      <Button onClick={generate} disabled={busy !== null}>
        <Icon name="sparkles" />
        {busy === busyLabel ? busyText : 'Generate'}
      </Button>
      <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy !== null}>
        Cancel
      </Button>
    </div>
  );
}

function Notice({ tone = 'zinc', children }) {
  const tones = {
    zinc: 'bg-zinc-100 text-zinc-600',
    amber: 'bg-amber-50 text-amber-800',
    red: 'bg-red-50 text-red-700',
  };
  return <p className={`rounded-md px-3 py-2 text-xs ${tones[tone]}`}>{children}</p>;
}

function AiDetails({ title, children }) {
  return (
    <details className="group text-xs text-zinc-500">
      <summary className="flex cursor-pointer select-none items-center gap-1 hover:text-zinc-700">
        <Icon name="chevron" className="size-3 transition-transform group-open:rotate-90" />
        {title}
      </summary>
      <div className="mt-1.5 whitespace-pre-wrap pl-4">{children}</div>
    </details>
  );
}

// Empty panel: what this media does, then the three ways to add it.
function EmptyMedia({ text, children, link }) {
  return (
    <div className="space-y-3 rounded-lg border border-dashed border-zinc-300 p-4">
      <p className="text-sm text-zinc-600">{text}</p>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      {link}
    </div>
  );
}

const isLocal = (url) => /\/\/(localhost|127\.0\.0\.1)[:/]/.test(url);

function ImagePanel({ post, editable, busy, run }) {
  const required = PLATFORMS[post.platform].needsImage;
  const canRemove = editable && (!required || post.status !== 'approved');

  const generate = (instructions) =>
    run('image-generate', () => api(`/posts/${post.id}/image/generate`, { method: 'POST', body: { instructions } }));
  const upload = (file) =>
    run('image-upload', async () => api(`/posts/${post.id}/image`, { method: 'PUT', body: { dataUrl: await toPostJpeg(file) } }));
  const addLink = (url) => run('image-link', () => api(`/posts/${post.id}/image`, { method: 'PUT', body: { url } }));
  const remove = () => run('image-remove', () => api(`/posts/${post.id}/image`, { method: 'DELETE' }));

  const ai = (label) => (
    <AiForm
      label={label}
      placeholder="Optional: what should it show? (e.g. flat illustration, our green colors, a coffee cup)"
      busy={busy}
      busyLabel="image-generate"
      busyText="Generating…"
      onGenerate={generate}
    />
  );

  if (!post.image_url) {
    if (!editable) return null;
    return (
      <EmptyMedia
        text={
          required
            ? 'Instagram needs an image or a video. Images are cropped to Instagram size automatically.'
            : 'Optional: post it as a photo with this caption.'
        }
        link={<LinkInput noun="image" busy={busy} busyLabel="image-link" onAdd={addLink} />}
      >
        {ai('Generate with AI')}
        <FileButton label={busy === 'image-upload' ? 'Uploading…' : 'Upload image'} accept="image/*" onFile={upload} busy={busy} />
      </EmptyMedia>
    );
  }

  // Instagram and Facebook download the image by link; X and LinkedIn get it uploaded by this server, so local is fine there.
  const local = ['instagram', 'meta'].includes(post.platform) && isLocal(post.image_url);
  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-zinc-100">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={post.image_url} alt="" className="mx-auto max-h-80 object-contain" />
      </div>
      {local && (
        <Notice tone="amber">
          This image is stored on this computer, so {PLATFORMS[post.platform].label} can&apos;t download it. Set up Media in Settings and
          upload it again.
        </Notice>
      )}
      {post.image_prompt && <AiDetails title="Image prompt (made with AI)">{post.image_prompt}</AiDetails>}
      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          {ai('New AI image')}
          {canRemove && (
            <Button variant="ghost" onClick={remove} disabled={busy !== null}>
              <Icon name="trash" />
              Remove
            </Button>
          )}
        </div>
      )}
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

const MAX_VIDEO_MB = 100;

// A video: uploaded, linked, or a short AI video. AI takes minutes, so the server makes it in the background and the card polls the post.
function VideoPanel({ post, editable, busy, run }) {
  const label = PLATFORMS[post.platform].label;

  const generate = (instructions) =>
    run('video-generate', () => api(`/posts/${post.id}/video/generate`, { method: 'POST', body: { instructions } }));
  const remove = () => run('video-remove', () => api(`/posts/${post.id}/video`, { method: 'DELETE' }));
  const upload = (file) =>
    run('video-upload', async () => {
      // Some browsers leave the type empty; the server takes MP4 and MOV only.
      const type = file.type || (/\.mov$/i.test(file.name) ? 'video/quicktime' : /\.mp4$/i.test(file.name) ? 'video/mp4' : '');
      if (!['video/mp4', 'video/quicktime'].includes(type)) throw new Error('Pick an MP4 or MOV video.');
      if (file.size > MAX_VIDEO_MB * 1024 * 1024) throw new Error(`The video is larger than ${MAX_VIDEO_MB} MB.`);
      return api(`/posts/${post.id}/video`, { method: 'PUT', body: file.type ? file : new Blob([file], { type }) });
    });
  const addLink = (url) => run('video-link', () => api(`/posts/${post.id}/video`, { method: 'PUT', body: { url } }));

  if (post.video_status === 'generating') {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-accent-100 bg-accent-50 px-4 py-3 text-sm text-accent-800">
        <span className="size-5 shrink-0 animate-spin rounded-full border-2 border-accent-300 border-t-accent-600" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">
            Making the video… <Elapsed since={post.video_started_at} />
          </div>
          <div className="text-xs opacity-80">Usually 1–3 minutes. It keeps going if you leave this page.</div>
        </div>
      </div>
    );
  }

  const ai = (text) => (
    <AiForm
      label={text}
      placeholder="Optional: what should happen? (e.g. slow pan over a busy café, warm morning light)"
      busy={busy}
      busyLabel="video-generate"
      busyText="Starting…"
      onGenerate={generate}
    />
  );
  const uploadButton = (text) => (
    <FileButton label={busy === 'video-upload' ? 'Uploading…' : text} accept="video/mp4,video/quicktime,.mp4,.mov" onFile={upload} busy={busy} />
  );
  const failed = post.video_status === 'failed' && post.video_error;

  if (!post.video_url) {
    if (!editable) return null;
    return (
      <div className="space-y-3">
        {failed && <Notice tone="red">The video could not be made: {post.video_error}</Notice>}
        <EmptyMedia
          text={`Optional: an MP4 or MOV up to ${MAX_VIDEO_MB} MB, or a short AI video. The post then goes out as a ${
            post.platform === 'instagram' ? 'Reel (3–90 seconds)' : `${label} video`
          }.`}
          link={<LinkInput noun="video" busy={busy} busyLabel="video-link" onAdd={addLink} />}
        >
          {ai(failed ? 'Try AI again' : 'Generate with AI')}
          {uploadButton('Upload video')}
        </EmptyMedia>
      </div>
    );
  }

  const local = post.platform === 'instagram' && isLocal(post.video_url);
  return (
    <div className="space-y-3">
      {failed && <Notice tone="red">The new video could not be made, so the earlier one is kept: {post.video_error}</Notice>}
      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-black">
        <video src={post.video_url} controls playsInline preload="metadata" className="mx-auto max-h-80" />
      </div>
      {post.image_url && !post.document_url && <Notice>This post goes out as a video; the image is only used if you remove the video.</Notice>}
      {local && (
        <Notice tone="amber">This video is stored on this computer, so Instagram can&apos;t download it. Set up Media in Settings and add it again.</Notice>
      )}
      {post.video_prompt && <AiDetails title="Video prompt (made with AI)">{post.video_prompt}</AiDetails>}
      {editable && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {ai('New AI video')}
            {uploadButton('Replace')}
            <Button variant="ghost" onClick={remove} disabled={busy !== null}>
              <Icon name="trash" />
              Remove
            </Button>
          </div>
          <LinkInput noun="video" busy={busy} busyLabel="video-link" onAdd={addLink} />
        </>
      )}
    </div>
  );
}

const MAX_PDF_MB = 30;

// LinkedIn PDF carousel (a document post): upload or link a finished PDF, or let AI write the slides and draw them.
function DocumentPanel({ post, editable, busy, run }) {
  const generate = (instructions) =>
    run('document-generate', () => api(`/posts/${post.id}/document/generate`, { method: 'POST', body: { instructions } }));
  const upload = (file) =>
    run('document-upload', async () => {
      if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) throw new Error('Pick a PDF file.');
      if (file.size > MAX_PDF_MB * 1024 * 1024) throw new Error(`The PDF is larger than ${MAX_PDF_MB} MB.`);
      const title = file.name.replace(/\.pdf$/i, '').trim() || 'Carousel';
      const pdf = file.type === 'application/pdf' ? file : new Blob([file], { type: 'application/pdf' });
      return api(`/posts/${post.id}/document?title=${encodeURIComponent(title)}`, { method: 'PUT', body: pdf });
    });
  const remove = () => run('document-remove', () => api(`/posts/${post.id}/document`, { method: 'DELETE' }));
  // The title comes from the file's name (Google Drive sends it).
  const addLink = (url) => run('document-link', () => api(`/posts/${post.id}/document`, { method: 'PUT', body: { url } }));

  const ai = (text) => (
    <AiForm
      label={text}
      placeholder="Optional: what should the slides cover? (e.g. 7 slides, step-by-step, end with a free audit offer)"
      busy={busy}
      busyLabel="document-generate"
      busyText="Making slides…"
      onGenerate={generate}
    />
  );
  const uploadButton = (text) => (
    <FileButton label={busy === 'document-upload' ? 'Uploading…' : text} accept="application/pdf,.pdf" onFile={upload} busy={busy} />
  );

  if (!post.document_url) {
    if (!editable) return null;
    return (
      <EmptyMedia
        text="Optional: swipeable slides with this text as the caption. Upload your own PDF, paste a link (a Google Slides link works), or let AI write and design the slides."
        link={<LinkInput noun="PDF" busy={busy} busyLabel="document-link" onAdd={addLink} />}
      >
        {ai('Generate with AI')}
        {uploadButton('Upload PDF')}
      </EmptyMedia>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 rounded-lg border border-zinc-200 px-3 py-2">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-red-50 text-red-600">
          <Icon name="document" className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-zinc-900">{post.document_title}</div>
          {post.document_pages ? (
            <div className="text-xs text-zinc-500">
              {post.document_pages} {post.document_pages === 1 ? 'page' : 'pages'}
            </div>
          ) : null}
        </div>
        <a
          href={post.document_url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm font-medium text-accent-600 hover:underline"
        >
          Open <Icon name="external" className="size-3.5" />
        </a>
      </div>
      <iframe src={post.document_url} title={post.document_title || 'PDF carousel'} className="h-[28rem] w-full rounded-lg border border-zinc-200 bg-zinc-100" />
      {post.document_url.includes('res.cloudinary.com') && (
        <Notice>Preview blank? In Cloudinary: Settings → Security → turn on &quot;Allow delivery of PDF and ZIP files&quot;. LinkedIn needs it too.</Notice>
      )}
      {(post.image_url || post.video_url) && <Notice>LinkedIn posts the carousel; the image and video are not posted while it is attached.</Notice>}
      {post.document_slides?.length > 0 && (
        <AiDetails title={`Slides (made with AI, ${post.document_slides.length})`}>
          <ol className="list-decimal space-y-0.5 pl-4 whitespace-normal">
            {post.document_slides.map((slide, i) => (
              <li key={i}>
                <span className="font-medium text-zinc-700">{slide.heading}</span>
                {slide.body && <span> · {slide.body}</span>}
              </li>
            ))}
          </ol>
        </AiDetails>
      )}
      {editable && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {ai('New AI carousel')}
            {uploadButton('Replace')}
            <Button variant="ghost" onClick={remove} disabled={busy !== null}>
              <Icon name="trash" />
              Remove
            </Button>
          </div>
          <LinkInput noun="PDF" busy={busy} busyLabel="document-link" onAdd={addLink} />
        </>
      )}
    </div>
  );
}

// Image / Video / PDF as tabs, so a card only shows one media panel at a time.
function MediaTabs({ post, editable, busy, run }) {
  const videoPending = post.video_status === 'generating';
  const tabs = [
    { key: 'image', label: 'Image', has: Boolean(post.image_url), Panel: ImagePanel },
    { key: 'video', label: 'Video', has: Boolean(post.video_url) || videoPending, Panel: VideoPanel },
    PLATFORMS[post.platform].documents && { key: 'document', label: 'PDF carousel', has: Boolean(post.document_url), Panel: DocumentPanel },
  ].filter((t) => t && (editable || t.has));
  // Open on what the post will actually publish with.
  const [tab, setTab] = useState(() => (post.document_url ? 'document' : post.video_url || videoPending ? 'video' : 'image'));

  if (tabs.length === 0) return null;
  const current = tabs.find((t) => t.key === tab) || tabs[0];
  const missing = PLATFORMS[post.platform].needsImage && !post.image_url && !post.video_url;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Media</h3>
        {missing && <span className="text-xs font-medium text-red-600">Instagram needs an image or a video</span>}
      </div>
      <div role="tablist" className="inline-flex max-w-full flex-wrap rounded-lg border border-zinc-200 bg-zinc-100 p-0.5">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === current.key}
            onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition ${
              t.key === current.key ? 'bg-surface text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-800'
            }`}
          >
            <Icon name={t.key} />
            {t.label}
            {t.has && <span className={`size-1.5 rounded-full ${t.key === 'video' && videoPending ? 'animate-pulse bg-amber-500' : 'bg-emerald-500'}`} />}
          </button>
        ))}
      </div>
      <current.Panel post={post} editable={editable} busy={busy} run={run} />
    </section>
  );
}

function MediaChip({ icon, children, tone = 'zinc' }) {
  const tones = { zinc: 'bg-zinc-100 text-zinc-600', amber: 'bg-amber-50 text-amber-800' };
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium ${tones[tone]}`}>
      <Icon name={icon} className="size-3.5" />
      {children}
    </span>
  );
}

// Collapsed, a card is one header (platform, first line, status, media) so long lists stay short.
// `expand` ({ open, at }) from the page opens or closes every card at once; `at` changes on each click.
export default function PostCard({ post, onUpdate, onRemove, defaultOpen = false, expand }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    if (expand?.at) setOpen(expand.open);
  }, [expand]);
  const [content, setContent] = useState(post.content);
  const [when, setWhen] = useState(post.scheduled_at ? toLocalInput(post.scheduled_at) : '');
  const [feedback, setFeedback] = useState('');
  const [showRewrite, setShowRewrite] = useState(false);
  const [busy, setBusy] = useState(null);

  useEffect(() => setContent(post.content), [post.content]);
  useEffect(() => setWhen(post.scheduled_at ? toLocalInput(post.scheduled_at) : ''), [post.scheduled_at]);

  const label = PLATFORMS[post.platform].label;
  const editable = ['draft', 'approved', 'failed'].includes(post.status);
  const dirty = content !== post.content;
  const count = charCount(post.platform, content);
  const { maxChars } = PLATFORMS[post.platform];
  const tooLong = count > maxChars;
  const missingImage = PLATFORMS[post.platform].needsImage && !post.image_url && !post.video_url;
  const videoPending = post.video_status === 'generating';
  const blocked = tooLong || missingImage || videoPending;

  // While the server makes the video, check the post every few seconds, and say when it's done.
  useEffect(() => {
    if (!videoPending) return;
    const timer = setInterval(() => {
      api(`/posts/${post.id}`)
        .then((latest) => {
          if (latest.video_status === 'generating') return;
          onUpdate(latest);
          if (latest.video_status === 'ready') toast.success(`${label} video is ready`);
          else toast.error(`${label} video could not be made`, { description: latest.video_error });
        })
        .catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [videoPending, post.id, onUpdate, label]);

  // Runs an action with a toast (loading, then success or the error). Returns the updated post, or null if it failed.
  async function run(key, action) {
    const [loading, done] = TOASTS[key] || ['Working…', 'Done'];
    const id = toast.loading(loading);
    setBusy(key);
    try {
      const updated = await action();
      if (updated) onUpdate(updated);
      if (key === 'publish' && updated?.status === 'failed') {
        toast.error(`Publishing to ${label} failed`, { id, description: updated.error });
      } else if (key === 'publish') {
        toast.success(updated?.simulated ? 'Published (simulated)' : `Published to ${label}`, {
          id,
          description: updated?.simulated ? 'No account is connected, or dry run is on: nothing really went out.' : undefined,
          action: updated?.external_url ? { label: 'View', onClick: () => window.open(updated.external_url, '_blank', 'noopener') } : undefined,
        });
      } else {
        toast.success(typeof done === 'function' ? done(updated) : done, { id });
      }
      return updated ?? null;
    } catch (err) {
      toast.error(err.message, { id });
      return null;
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
    if (!window.confirm(`Publish this post to ${label} now?`)) return;
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

  const firstLine = content.split('\n').find((line) => line.trim()) || 'Empty post';
  const time =
    post.status === 'approved' && post.scheduled_at
      ? `Posts ${formatDateTime(post.scheduled_at)}`
      : post.status === 'published' && post.published_at
        ? `Published ${formatDateTime(post.published_at)}`
        : null;

  return (
    <Card className={`transition ${open ? 'shadow-md' : 'hover:border-zinc-300 hover:shadow-md'}`}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-start gap-3 text-left">
        <PlatformIcon platform={post.platform} />
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-medium text-zinc-900 ${open ? 'line-clamp-2' : 'truncate'}`}>{firstLine}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <StatusBadge status={post.status} simulated={post.simulated} />
            {time && (
              <span className="inline-flex items-center gap-1 text-xs text-zinc-500">
                <Icon name="clock" className="size-3.5" />
                {time}
              </span>
            )}
            {post.document_url && <MediaChip icon="document">PDF · {post.document_pages || '?'}</MediaChip>}
            {videoPending ? (
              <MediaChip icon="video" tone="amber">
                Making video…
              </MediaChip>
            ) : (
              post.video_url && <MediaChip icon="video">Video</MediaChip>
            )}
            {post.image_url && <MediaChip icon="image">Image</MediaChip>}
            {post.brand_score != null && (
              <span
                className={`text-xs font-medium ${post.brand_score >= 8 ? 'text-emerald-700' : 'text-amber-700'}`}
                title="Self-review score against your Brand Brain"
              >
                ★ {post.brand_score}/10
              </span>
            )}
            {dirty && <span className="text-xs font-medium text-amber-700">Unsaved edits</span>}
          </div>
          {!open && post.error && <p className="mt-1.5 truncate text-xs text-red-600">{post.error}</p>}
        </div>
        <span className={`mt-1 rounded-full p-1 text-zinc-400 transition ${open ? 'rotate-90 bg-zinc-100 text-zinc-700' : ''}`}>
          <Icon name="chevron" />
        </span>
      </button>

      {open && (
        <div className="mt-5 space-y-5 border-t border-zinc-100 pt-5">
          {post.error && <ErrorText error={post.error} />}

          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Caption</h3>
              <span className={`text-xs tabular-nums ${tooLong ? 'font-semibold text-red-600' : 'text-zinc-400'}`}>
                {count} / {maxChars}
              </span>
            </div>
            <textarea
              className="input min-h-36 font-[inherit] leading-relaxed"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              disabled={!editable || busy !== null}
              rows={Math.min(Math.max(content.split('\n').length + 1, 5), 16)}
            />
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <AiDetails title="Brief">{post.brief}</AiDetails>
              {post.critique && post.status === 'draft' && (
                <AiDetails title="Editor notes">
                  <ul className="list-disc space-y-0.5 pl-4 whitespace-normal">
                    {post.critique.split('\n').map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                </AiDetails>
              )}
            </div>
            {showRewrite && (
              <div className="flex flex-col gap-2 rounded-lg border border-accent-100 bg-accent-50 p-2 sm:flex-row">
                <input
                  className="input"
                  placeholder="What should change? (optional, e.g. shorter, more personal, add a question)"
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && rewrite()}
                  autoFocus
                />
                <Button onClick={rewrite} disabled={busy !== null}>
                  <Icon name="sparkles" />
                  {busy === 'rewrite' ? 'Rewriting…' : 'Rewrite'}
                </Button>
                <Button variant="ghost" onClick={() => setShowRewrite(false)} disabled={busy !== null}>
                  Cancel
                </Button>
              </div>
            )}
          </section>

          <MediaTabs post={post} editable={editable} busy={busy} run={run} />

          <div className="-mx-5 -mb-5 flex flex-wrap items-center gap-2 rounded-b-xl border-t border-zinc-200 bg-zinc-50 px-5 py-3">
            {(post.status === 'draft' || post.status === 'failed') && (
              <>
                <input
                  type="datetime-local"
                  className="input w-auto"
                  value={when}
                  onChange={(e) => setWhen(e.target.value)}
                  title="Leave empty to use the platform's default posting time"
                />
                <Button
                  onClick={approve}
                  disabled={busy !== null || blocked}
                  title={videoPending ? 'Wait for the video to finish' : missingImage ? 'Add an image or a video first' : undefined}
                >
                  <Icon name="clock" />
                  {busy === 'approve' ? 'Approving…' : when ? 'Approve & schedule' : 'Approve (default time)'}
                </Button>
              </>
            )}
            {post.status === 'draft' && (
              <Button variant="secondary" onClick={() => setShowRewrite((v) => !v)} disabled={busy !== null}>
                <Icon name="sparkles" className="size-4 text-accent-600" />
                Rewrite with AI
              </Button>
            )}
            {(post.status === 'approved' || post.status === 'failed') && (
              <Button variant="secondary" onClick={publishNow} disabled={busy !== null || blocked}>
                <Icon name="send" />
                {busy === 'publish' ? 'Publishing…' : 'Publish now'}
              </Button>
            )}
            {(post.status === 'approved' || post.status === 'failed') && (
              <Button variant="ghost" onClick={unapprove} disabled={busy !== null}>
                <Icon name="undo" />
                Back to draft
              </Button>
            )}
            {editable && dirty && (
              <Button variant="secondary" onClick={save} disabled={busy !== null || tooLong}>
                <Icon name="pencil" />
                {busy === 'save' ? 'Saving…' : 'Save edits'}
              </Button>
            )}
            {post.external_url && (
              <a
                href={post.external_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm font-medium text-accent-600 hover:underline"
              >
                View post <Icon name="external" className="size-3.5" />
              </a>
            )}
            {editable && (
              <Button variant="danger" className="ml-auto" onClick={remove} disabled={busy !== null}>
                <Icon name="trash" />
                Delete
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
