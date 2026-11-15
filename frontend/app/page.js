'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { notifyChats } from '@/lib/chatEvents';
import Link from 'next/link';
import { useAuth } from '@/components/auth';
import { useAuthModal } from '@/components/AuthModal';
import { ErrorText } from '@/components/ui';
import PostCard from '@/components/PostCard';

// What each agent tool did, in the user's words.
const TOOL_LABELS = {
  get_writing_guide: 'Read the Brand Brain',
  update_brand_brain: 'Updated the Brand Brain',
  list_calendar: 'Checked the calendar',
  add_calendar_items: 'Added to the calendar',
  list_posts: 'Looked at posts',
  create_post: 'Saved a draft',
  update_post: 'Edited a draft',
  set_post_image: 'Attached an image',
  set_post_video: 'Attached a video',
  generate_post_image: 'Made an AI image',
  generate_post_video: 'Started an AI video',
  generate_post_carousel: 'Made a PDF carousel',
  set_post_document: 'Attached a PDF',
  check_post_quality: 'Checked a post',
  set_post_image_alt: 'Set image alt text',
  unschedule_post: 'Moved a post back to draft',
};

const PATHS = {
  spark: 'M12 3l1.8 4.9L19 9.7l-4.9 1.8L12 16.4l-1.8-4.9L5.3 9.7l4.9-1.8L12 3ZM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z',
  send: 'M5 12h14M13 6l6 6-6 6',
  check: 'm5 12 4 4 10-10',
  x: 'M6 6l12 12M18 6 6 18',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
  pen: 'M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3.6 9h16.8M3.6 15h16.8M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
};

function Glyph({ name, className = 'size-4', strokeWidth = 1.8 }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name]} />
    </svg>
  );
}

const SUGGESTIONS = [
  { icon: 'calendar', title: 'Plan my week', text: 'A week of posts for LinkedIn and X', prompt: 'Plan next week for LinkedIn and X' },
  { icon: 'pen', title: 'Write a post', text: 'About our newest client result', prompt: 'Write a LinkedIn post about our newest client result' },
  { icon: 'chart', title: 'Improve my drafts', text: 'Check drafts and fix what the review found', prompt: 'Look at my drafts and fix the ones that need work' },
  { icon: 'globe', title: 'বাংলায় লেখো', text: 'Facebook-এর জন্য একটা post', prompt: 'আমার brand-এর জন্য একটা Facebook post লেখো' },
];

function AgentAvatar({ size = 'size-8' }) {
  return (
    <span className={`grid ${size} shrink-0 place-items-center rounded-full bg-accent-600 text-white shadow-sm ring-4 ring-accent-50`}>
      <Glyph name="spark" className="size-[55%]" />
    </span>
  );
}

// The agent may mark words as **bold**; show them bold instead of with stars.
function RichText({ text }) {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <strong key={i} className="font-semibold text-zinc-900">{part}</strong> : part));
}

function ToolSteps({ tools }) {
  if (!tools?.length) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {tools.map((tool, i) => {
        const failed = tool.ok === false;
        return (
          <li
            key={i}
            title={tool.error || undefined}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
              failed ? 'border-red-100 bg-red-50 text-red-700' : 'border-zinc-200 bg-zinc-50 text-zinc-600'
            }`}
          >
            <span className={`grid size-4 place-items-center rounded-full ${failed ? 'bg-red-100' : 'bg-emerald-100 text-emerald-700'}`}>
              <Glyph name={failed ? 'x' : 'check'} className="size-2.5" strokeWidth={3} />
            </span>
            {TOOL_LABELS[tool.name] || tool.name}
          </li>
        );
      })}
    </ul>
  );
}

function Message({ message, posts, cardIds = [], continued = false, onUpdate, onRemove }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent-600 px-4 py-2.5 text-sm leading-relaxed text-white shadow-sm sm:max-w-[75%]">
          {message.text}
        </p>
      </div>
    );
  }
  const cards = cardIds.map((id) => posts[id]).filter(Boolean);
  return (
    // Steps of one answer sit under a single avatar.
    <div className={`flex gap-3 ${continued ? '-mt-3' : ''}`}>
      {continued ? <span className="w-8 shrink-0" aria-hidden /> : <AgentAvatar />}
      <div className="min-w-0 flex-1 space-y-3 pt-1">
        {(message.text || message.tools?.length > 0) && (
          <div>
            {message.text && (
              <p className="whitespace-pre-wrap text-[15px] leading-7 text-zinc-700">
                <RichText text={message.text} />
              </p>
            )}
            <ToolSteps tools={message.tools} />
          </div>
        )}
        {cards.map((post) => (
          <PostCard key={post.id} post={post} onUpdate={onUpdate} onRemove={onRemove} />
        ))}
      </div>
    </div>
  );
}

function Thinking() {
  return (
    <div className="flex items-center gap-3" role="status">
      <AgentAvatar />
      <div className="flex items-center gap-3 rounded-2xl rounded-tl-md border border-zinc-200 bg-zinc-50 px-4 py-3">
        <span className="flex gap-1" aria-hidden>
          {[0, 150, 300].map((delay) => (
            <span key={delay} className="size-1.5 animate-bounce rounded-full bg-accent-500" style={{ animationDelay: `${delay}ms` }} />
          ))}
        </span>
        <span className="text-sm text-zinc-500">Working on it, this can take up to a minute</span>
      </div>
    </div>
  );
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

function Welcome({ onPick, composer }) {
  const { user } = useAuth();
  const first = user?.name?.trim().split(/\s+/).at(-1);
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center px-2 text-center">
      <h2 className="flex flex-col items-center gap-3 font-serif text-3xl font-semibold tracking-tight text-zinc-900 sm:flex-row sm:text-4xl">
        <AgentAvatar size="size-10" />
        {greeting()}{first ? `, ${first}` : ''}
      </h2>
      <p className="mt-3 max-w-md text-sm leading-6 text-zinc-500">
        Ask in English or বাংলা. The agent plans, writes and fixes posts with your Brand Brain. Nothing goes live until you approve it.
      </p>
      <div className="mt-6 w-full text-left">{composer}</div>
      <div className="mt-4 grid w-full grid-cols-2 gap-2 sm:gap-3">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.title}
            type="button"
            onClick={() => onPick(s.prompt)}
            className="group flex items-start gap-3 rounded-xl border border-zinc-200 bg-surface p-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-accent-300 hover:shadow-md sm:p-4"
          >
            <span className="hidden size-9 shrink-0 place-items-center rounded-lg bg-accent-50 text-accent-700 transition group-hover:bg-accent-100 sm:grid">
              <Glyph name={s.icon} className="size-[18px]" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-zinc-900">{s.title}</span>
              <span className="mt-0.5 block text-xs leading-5 text-zinc-500">{s.text}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

// Shown above the message box when the chat can't run yet: not signed in, or no AI connected.
function SetupNotice({ guest, onAuth }) {
  return (
    <div className="mx-auto mb-3 flex max-w-3xl flex-col gap-3 rounded-2xl border border-accent-100 bg-accent-50 px-4 py-3 text-left sm:flex-row sm:items-center">
      <span className="hidden size-9 shrink-0 place-items-center rounded-xl bg-surface text-accent-700 ring-1 ring-accent-100 sm:grid">
        <Glyph name="spark" className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-zinc-900">{guest ? 'Sign in to start chatting' : 'Connect an AI to start chatting'}</p>
        <p className="mt-0.5 text-xs leading-5 text-zinc-600">
          {guest
            ? 'Create a free account, then connect your own AI provider. Google Gemini has a free tier.'
            : 'Add an AI provider in Settings → AI. Google Gemini has a free tier; Claude gives the best results.'}
        </p>
      </div>
      {guest ? (
        <div className="flex shrink-0 gap-2">
          <button type="button" onClick={() => onAuth('login')} className="rounded-lg border border-zinc-300 bg-surface px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50">
            Log in
          </button>
          <button type="button" onClick={() => onAuth('signup')} className="rounded-lg bg-accent-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-accent-700 dark:hover:brightness-110">
            Sign up
          </button>
        </div>
      ) : (
        <Link href="/settings#ai" className="shrink-0 rounded-lg bg-accent-600 px-3 py-1.5 text-center text-sm font-semibold text-white shadow-sm hover:bg-accent-700 dark:hover:brightness-110">
          Connect AI
        </Link>
      )}
    </div>
  );
}

function ChatView() {
  const router = useRouter();
  const requested = useSearchParams().get('c'); // the conversation in the URL, none = new chat
  const { status } = useAuth();
  const { openAuth } = useAuthModal();
  const guest = status !== 'signed-in';
  const [ai, setAi] = useState(null); // the workspace's AI provider status, once loaded
  const needsAi = !guest && ai !== null && !ai.ready;
  const [current, setCurrent] = useState(null);
  const [title, setTitle] = useState('');
  const [messages, setMessages] = useState([]);
  const [posts, setPosts] = useState({});
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const bottom = useRef(null);
  const inputRef = useRef(null);
  const currentRef = useRef(null);
  currentRef.current = current;

  const addPosts = (list) => setPosts((map) => ({ ...map, ...Object.fromEntries(list.map((p) => [p.id, p])) }));
  const update = useCallback((post) => setPosts((map) => ({ ...map, [post.id]: post })), []);
  const remove = useCallback((id) => setPosts((map) => {
    const { [id]: _, ...rest } = map;
    return rest;
  }), []);

  // Whether an AI provider is connected; checked again when the user comes back to this tab (e.g. from Settings).
  useEffect(() => {
    if (guest) return setAi(null);
    const check = () => api('/status').then((s) => setAi(s.ai || null)).catch(() => {});
    check();
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [guest]);

  // Follow the URL: open the conversation it names, or start fresh. A chat this page just created is already shown.
  useEffect(() => {
    if (guest) return; // guests have no saved chats
    if (requested && requested === currentRef.current) return;
    setError('');
    setPosts({});
    setInput('');
    if (!requested) {
      setCurrent(null);
      setTitle('');
      setMessages([]);
      notifyChats(null);
      inputRef.current?.focus();
      return;
    }
    let cancelled = false;
    setLoading(true);
    setMessages([]);
    api(`/chat/conversations/${requested}`)
      .then((view) => {
        if (cancelled) return;
        setCurrent(view.id);
        setTitle(view.title);
        setMessages(view.messages);
        addPosts(view.posts);
        notifyChats(view.id);
      })
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [requested, guest]);

  useEffect(() => {
    if (messages.length || busy) bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, busy]);

  // The message box grows with its text, up to a limit.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  async function send(text) {
    const message = text.trim();
    if (!message || busy) return;
    // Keep what they typed: after signing in (or connecting an AI) they can send it as it is.
    if (guest) {
      setInput(message);
      return openAuth('signup');
    }
    if (needsAi) {
      setInput(message);
      return;
    }
    setBusy(true);
    setError('');
    setInput('');
    setMessages((list) => [...list, { role: 'user', text: message }]);
    try {
      const result = await api('/chat', { method: 'POST', body: { conversation_id: current, message } });
      addPosts(result.posts);
      // The reply starts with the user's message, already shown.
      setMessages((list) => [...list, ...result.messages.slice(1)]);
      if (!current) {
        setCurrent(result.conversation_id);
        currentRef.current = result.conversation_id;
        setTitle(result.title);
        router.replace(`/?c=${result.conversation_id}`, { scroll: false });
      }
      notifyChats(result.conversation_id);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  // Each post card is shown once, under the last message that touched it (a draft is often saved, then fixed).
  const cardsAt = new Map();
  const lastTouch = new Map();
  messages.forEach((m, i) => (m.post_ids || []).forEach((id) => lastTouch.set(id, i)));
  for (const [id, i] of lastTouch) cardsAt.set(i, [...(cardsAt.get(i) || []), id]);

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(input);
    }
  }

  const empty = !loading && messages.length === 0;

  const composer = (
    <>
    {(guest || needsAi) && <SetupNotice guest={guest} onAuth={(mode) => openAuth(mode)} />}
    <form
      onSubmit={(e) => {
        e.preventDefault();
        send(input);
      }}
      className="mx-auto flex max-w-3xl items-end gap-2 rounded-3xl border border-zinc-300 bg-surface p-2 pl-5 shadow-[0_2px_12px_rgba(0,0,0,0.06)] transition focus-within:border-accent-500 focus-within:ring-4 focus-within:ring-accent-100"
    >
      <label htmlFor="chat-input" className="sr-only">Message</label>
      <textarea
        id="chat-input"
        ref={inputRef}
        className="max-h-[200px] min-h-[40px] flex-1 resize-none bg-transparent py-2 text-[15px] leading-6 text-zinc-900 placeholder:text-zinc-400 focus:outline-none"
        rows={1}
        maxLength={4000}
        placeholder={current ? 'Reply to the agent…' : 'How can I help with your content today?'}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={busy}
        autoFocus
      />
      <button
        type="submit"
        disabled={busy || needsAi || !input.trim()}
        className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-600 text-white shadow-sm transition hover:bg-accent-700 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400 disabled:shadow-none dark:hover:brightness-110"
        aria-label="Send"
      >
        <Glyph name="send" className="size-[18px]" strokeWidth={2.2} />
      </button>
    </form>
    </>
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-surface">
      {guest && (
        <div className="absolute top-3 right-4 z-10 hidden gap-2 lg:flex">
          <button type="button" onClick={() => openAuth('login')} className="rounded-lg px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100">
            Log in
          </button>
          <button type="button" onClick={() => openAuth('signup')} className="rounded-lg bg-zinc-900 px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-zinc-700 dark:bg-zinc-800 dark:text-zinc-50 dark:hover:bg-zinc-700">
            Sign up free
          </button>
        </div>
      )}
      {!empty && (
        <header className="flex h-12 shrink-0 items-center justify-center border-b border-zinc-200 px-4">
          <h1 className="truncate text-sm font-medium text-zinc-800">{title || 'New chat'}</h1>
        </header>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={`mx-auto max-w-3xl space-y-6 px-4 sm:px-6 ${empty ? 'flex min-h-full flex-col justify-center py-8' : 'py-8'}`}>
          {loading && <p className="text-center text-sm text-zinc-500">Loading…</p>}
          {empty && <Welcome onPick={send} composer={composer} />}
          {messages.map((m, i) => (
            <Message
              key={i}
              message={m}
              posts={posts}
              cardIds={cardsAt.get(i)}
              continued={m.role === 'assistant' && messages[i - 1]?.role === 'assistant'}
              onUpdate={update}
              onRemove={remove}
            />
          ))}
          {busy && <Thinking />}
          {error && <ErrorText error={error} />}
          <div ref={bottom} />
        </div>
      </div>

      {!empty && (
        <div className="shrink-0 px-3 pb-3 sm:px-6 sm:pb-4">
          {composer}
          <p className="mx-auto mt-2 hidden max-w-3xl text-center text-[11px] text-zinc-400 sm:block">
            The agent saves drafts only. Nothing is published until you approve it.
          </p>
        </div>
      )}
    </div>
  );
}

export default function ChatPage() {
  return (
    <Suspense fallback={null}>
      <ChatView />
    </Suspense>
  );
}
