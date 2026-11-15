'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { CHAT_EVENT } from '@/lib/chatEvents';
import { AuthModalProvider, useAuthModal } from '@/components/AuthModal';
import { AccentPicker, ModeSwitch } from '@/components/theme';
import { AuthProvider, safeNext, UserAvatar, useAuth } from '@/components/auth';
import { FullPageSpinner } from '@/components/AuthLayout';
import VerifyEmailGate from '@/components/VerifyEmailGate';

const ICON_PATHS = {
  dashboard: 'M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
  posts: 'M4 4h16v16H4zM8 9h8M8 13h8M8 17h5',
  instant: 'M13 2 4 14h7l-1 8 9-12h-7l1-8Z',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12ZM8 10h8M8 14h5',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  brand: 'M12 3a6 6 0 0 0-6 6c0 2.2 1.2 3.6 2.3 4.7.8.8 1.2 1.6 1.2 2.6V17h5v-.7c0-1 .4-1.8 1.2-2.6C16.8 12.6 18 11.2 18 9a6 6 0 0 0-6-6ZM9.5 21h5',
  connections: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-4l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  chevron: 'm7 15 5 5 5-5M7 9l5-5 5 5',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  x: 'M6 6l12 12M18 6 6 18',
};

export function Icon({ name, className = 'size-[18px]' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

// Main pages, under "New chat" in the sidebar.
const WORKSPACE_LINKS = [
  { href: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
  { href: '/posts', label: 'Posts', icon: 'posts' },
  { href: '/calendar', label: 'Calendar', icon: 'calendar' },
  { href: '/instant', label: 'Instant', icon: 'instant' },
];
// Setup and admin pages live in the menu behind the user row at the bottom.
const SETUP_LINKS = [
  { href: '/brand', label: 'Brand Brain', icon: 'brand' },
  { href: '/connections', label: 'Connections', icon: 'connections' },
  { href: '/settings', label: 'Settings', icon: 'settings' },
];
const ADMIN_LINKS = [{ href: '/admin/users', label: 'Users', icon: 'users' }];

const ALL_LINKS = [
  ...WORKSPACE_LINKS,
  ...SETUP_LINKS,
  ...ADMIN_LINKS,
  { href: '/', label: 'Chat', icon: 'chat' },
  { href: '/account', label: 'Account', icon: 'user' },
];
const isActive = (href, pathname) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

// Pages anyone can open without signing in. They bring their own layout.
const PUBLIC_ROUTES = ['/login', '/signup', '/forgot-password', '/reset-password', '/verify-email'];
// Signed-in users skip these and go straight into the app.
const GUEST_ONLY = ['/login', '/signup', '/forgot-password'];

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5 px-2">
      <span className="grid size-8 place-items-center rounded-lg bg-accent-600 text-white shadow-sm">
        <svg viewBox="0 0 24 24" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4 12a8 8 0 0 1 14.3-4.9M20 12a8 8 0 0 1-14.3 4.9M18 3v4h-4M6 21v-4h4" />
        </svg>
      </span>
      <span className="leading-tight">
        <span className="block font-serif text-[17px] font-semibold tracking-tight text-zinc-900">Content Agent</span>
        <span className="block text-[11px] text-zinc-500">Social media studio</span>
      </span>
    </Link>
  );
}

function MenuLink({ href, icon, label, pathname, onClick }) {
  const active = isActive(href, pathname);
  return (
    <Link
      href={href}
      role="menuitem"
      onClick={onClick}
      className={`flex items-center gap-2.5 px-3 py-2 text-sm ${active ? 'bg-accent-50 font-medium text-accent-700' : 'text-zinc-700 hover:bg-zinc-100'}`}
    >
      <Icon name={icon} className="size-4" /> {label}
    </Link>
  );
}

// The user row at the bottom of the sidebar. Its menu holds setup, admin, appearance and the account.
function UserMenu({ pathname, onNavigate }) {
  const { user, logout, isAdmin } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function signOut() {
    await logout();
    router.replace('/login');
  }

  const go = () => {
    setOpen(false);
    onNavigate?.();
  };

  return (
    <div ref={ref} className="relative">
      {open && (
        <div role="menu" className="absolute inset-x-0 bottom-full z-10 mb-2 max-h-[75vh] overflow-y-auto rounded-xl border border-zinc-200 bg-surface py-1 shadow-xl">
          <div className="border-b border-zinc-200 px-3 py-2">
            <div className="truncate text-xs text-zinc-500">Signed in as</div>
            <div className="truncate text-sm font-medium text-zinc-900">{user.email}</div>
          </div>
          <p className="px-3 pt-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Setup</p>
          {SETUP_LINKS.map((l) => (
            <MenuLink key={l.href} {...l} pathname={pathname} onClick={go} />
          ))}
          {isAdmin && (
            <>
              <p className="px-3 pt-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Admin</p>
              {ADMIN_LINKS.map((l) => (
                <MenuLink key={l.href} {...l} pathname={pathname} onClick={go} />
              ))}
            </>
          )}
          <div className="mt-1 space-y-2.5 border-y border-zinc-200 px-3 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-zinc-500">Theme</span>
              <ModeSwitch />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-zinc-500">Accent</span>
              <AccentPicker />
            </div>
          </div>
          <MenuLink href="/account" icon="user" label="Account settings" pathname={pathname} onClick={go} />
          <button role="menuitem" onClick={signOut} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50">
            <Icon name="logout" className="size-4" /> Sign out
          </button>
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Open settings menu"
        className={`flex w-full items-center gap-3 rounded-lg p-2 text-left transition hover:bg-zinc-100 ${open ? 'bg-zinc-100' : ''}`}
      >
        <UserAvatar user={user} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-zinc-900">{user.name}</span>
          <span className="block truncate text-xs text-zinc-500">{user.role === 'admin' ? 'Owner · Admin' : user.workspace?.name}</span>
        </span>
        <Icon name="gear" className="size-[18px] text-zinc-500" />
      </button>
    </div>
  );
}

const rowClass = (active) =>
  `flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
    active ? 'bg-zinc-200/70 font-medium text-zinc-900 dark:bg-zinc-100' : 'text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900'
  }`;

// Recent chats in the sidebar, with search and delete. The chat page keeps it current through CHAT_EVENT.
function ChatList({ pathname, onNavigate, searching, onCloseSearch }) {
  const router = useRouter();
  const [chats, setChats] = useState(null); // null until the first load
  const [activeId, setActiveId] = useState(null);
  const [query, setQuery] = useState('');

  const load = useCallback(() => api('/chat/conversations').then(setChats).catch(() => setChats((list) => list || [])), []);
  useEffect(() => {
    load();
    const onChange = (e) => {
      setActiveId(e.detail?.activeId ?? null);
      load();
    };
    window.addEventListener(CHAT_EVENT, onChange);
    return () => window.removeEventListener(CHAT_EVENT, onChange);
  }, [load]);

  async function remove(chat) {
    if (!window.confirm(`Delete "${chat.title}"? Posts it made stay in Posts.`)) return;
    try {
      await api(`/chat/conversations/${chat.id}`, { method: 'DELETE' });
      setChats((list) => (list || []).filter((c) => c.id !== chat.id));
      if (chat.id === activeId && pathname === '/') router.push('/');
    } catch (err) {
      toast.error(err.message);
    }
  }

  const q = query.trim().toLowerCase();
  const shown = (chats || []).filter((c) => !q || c.title.toLowerCase().includes(q));
  const onChat = pathname === '/';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {searching && (
        <div className="relative mb-2 px-1">
          <input
            autoFocus
            className="w-full rounded-lg border border-zinc-200 bg-surface py-1.5 pr-8 pl-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-accent-500 focus:outline-none"
            placeholder="Search chats"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && (setQuery(''), onCloseSearch())}
          />
          <button
            type="button"
            onClick={() => {
              setQuery('');
              onCloseSearch();
            }}
            className="absolute top-1/2 right-2.5 -translate-y-1/2 text-zinc-400 hover:text-zinc-700"
            aria-label="Close search"
          >
            <Icon name="x" className="size-3.5" />
          </button>
        </div>
      )}
      <p className="mb-1 px-3 text-xs font-medium text-zinc-500">Recents</p>
      <ul className="min-h-0 flex-1 space-y-px overflow-y-auto pb-2">
        {chats && shown.length === 0 && <li className="px-3 py-1.5 text-sm text-zinc-400">{q ? 'No chats match.' : 'No chats yet.'}</li>}
        {shown.map((chat) => {
          const active = onChat && chat.id === activeId;
          return (
            <li key={chat.id} className="group relative">
              <Link
                href={`/?c=${chat.id}`}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                className={`block truncate rounded-lg px-3 py-1.5 pr-8 text-sm transition ${
                  active ? 'bg-zinc-200/70 font-medium text-zinc-900 dark:bg-zinc-100' : 'text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900'
                }`}
              >
                {chat.title}
              </Link>
              <button
                type="button"
                onClick={() => remove(chat)}
                className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md p-1 text-zinc-400 opacity-0 transition group-hover:opacity-100 hover:bg-zinc-200 hover:text-red-600 focus:opacity-100"
                aria-label={`Delete ${chat.title}`}
              >
                <Icon name="trash" className="size-3.5" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// What a visitor who isn't signed in sees in place of their chats and account.
function GuestPanel({ onNavigate }) {
  const { openAuth } = useAuthModal();
  const open = (mode) => {
    onNavigate?.();
    openAuth(mode);
  };
  return (
    <>
      <div className="mt-5 flex-1">
        <div className="mx-1 rounded-xl border border-zinc-200 bg-surface p-4">
          <p className="text-sm font-semibold text-zinc-900">Save your chats</p>
          <p className="mt-1 text-xs leading-5 text-zinc-500">Sign in to connect your AI, keep your conversations and turn them into posts.</p>
        </div>
      </div>
      <div className="space-y-2 border-t border-zinc-200 px-1 pt-3">
        <button
          type="button"
          onClick={() => open('signup')}
          className="w-full rounded-lg bg-accent-600 px-3 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-accent-700 dark:hover:brightness-110"
        >
          Sign up free
        </button>
        <button
          type="button"
          onClick={() => open('login')}
          className="w-full rounded-lg border border-zinc-300 bg-surface px-3 py-2 text-sm font-medium text-zinc-800 transition hover:bg-zinc-50"
        >
          Log in
        </button>
        <div className="flex items-center justify-between px-1 pt-1">
          <span className="text-xs font-medium text-zinc-500">Theme</span>
          <ModeSwitch />
        </div>
      </div>
    </>
  );
}

function SidebarContent({ pathname, onNavigate, guest = false }) {
  const [searching, setSearching] = useState(false);
  const { openAuth } = useAuthModal();
  // Guests can open the chat; every other page asks them to sign in first.
  const gated = (href) => (e) => {
    if (!guest) return onNavigate?.();
    e.preventDefault();
    onNavigate?.();
    openAuth('login', href);
  };
  return (
    <div className="flex h-full flex-col px-2 py-3">
      <div className="mb-3 px-1">
        <Logo />
      </div>
      <nav className="space-y-px">
        <Link href="/" onClick={onNavigate} className={rowClass(false)}>
          <span className="grid size-5 place-items-center rounded-full bg-accent-600 text-white">
            <Icon name="plus" className="size-3.5" />
          </span>
          <span className="font-medium">New chat</span>
        </Link>
        {!guest && (
          <button type="button" onClick={() => setSearching((v) => !v)} className={rowClass(searching)}>
            <Icon name="search" />
            Search
          </button>
        )}
        {WORKSPACE_LINKS.map(({ href, label, icon }) => {
          const active = isActive(href, pathname);
          return (
            <Link key={href} href={href} onClick={gated(href)} aria-current={active ? 'page' : undefined} className={rowClass(active)}>
              <Icon name={icon} />
              {label}
            </Link>
          );
        })}
      </nav>
      {guest ? (
        <GuestPanel onNavigate={onNavigate} />
      ) : (
        <>
          <div className="mt-5 flex min-h-0 flex-1 flex-col">
            <ChatList pathname={pathname} onNavigate={onNavigate} searching={searching} onCloseSearch={() => setSearching(false)} />
          </div>
          <div className="border-t border-zinc-200 pt-2">
            <UserMenu pathname={pathname} onNavigate={onNavigate} />
          </div>
        </>
      )}
    </div>
  );
}

function Shell({ children, guest = false }) {
  const pathname = usePathname();
  const { isAdmin } = useAuth();
  const { openAuth } = useAuthModal();
  const [open, setOpen] = useState(false);
  const current = ALL_LINKS.find((l) => isActive(l.href, pathname));
  const forbidden = pathname.startsWith('/admin') && !isAdmin;
  // The chat fills the whole area beside the sidebar and brings its own top bar.
  const fullBleed = pathname === '/';

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="min-h-screen lg:pl-64">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-zinc-200 bg-sidebar lg:block">
        <SidebarContent pathname={pathname} guest={guest} />
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto border-r border-zinc-200 bg-sidebar shadow-xl">
            <SidebarContent pathname={pathname} guest={guest} onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}

      <header className={`sticky top-0 z-30 border-b border-zinc-200 bg-surface/85 backdrop-blur ${fullBleed ? 'lg:hidden' : ''}`}>
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <button
            className="-ml-1 rounded-md p-1.5 text-zinc-600 hover:bg-zinc-100 lg:hidden"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
          >
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="hidden text-zinc-400 sm:inline">Content Agent</span>
            <span className="hidden text-zinc-300 sm:inline">/</span>
            <span className="truncate font-medium text-zinc-900">{current?.label || 'Page'}</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {guest ? (
              <button
                type="button"
                onClick={() => openAuth('login')}
                className="rounded-md bg-accent-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-accent-700 dark:hover:brightness-110"
              >
                Log in
              </button>
            ) : (
            <Link
              href="/instant"
              className="hidden items-center gap-1.5 rounded-md bg-accent-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-accent-700 dark:hover:bg-accent-600 dark:hover:brightness-110 sm:inline-flex"
            >
              <Icon name="instant" className="size-4" />
              New post
            </Link>
            )}
          </div>
        </div>
      </header>

      <main className={fullBleed ? 'h-[calc(100dvh-3.5rem)] lg:h-dvh' : 'mx-auto max-w-6xl px-4 py-8 sm:px-6'}>
        {forbidden ? (
          <div className="mx-auto max-w-md rounded-xl border border-zinc-200 bg-surface p-8 text-center">
            <p className="font-serif text-lg font-semibold text-zinc-900">Admins only</p>
            <p className="mt-1 text-sm text-zinc-500">This page is for the app owner.</p>
          </div>
        ) : (
          children
        )}
      </main>
    </div>
  );
}

// Decides what to show: the public pages, the chat home (open to guests), the sign-in popup for every
// other page, the verify-email screen, or the app.
function Gate({ children }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, status } = useAuth();
  const isPublic = PUBLIC_ROUTES.some((r) => pathname.startsWith(r));
  const guestOnly = GUEST_ONLY.some((r) => pathname.startsWith(r));
  const isHome = pathname === '/';

  useEffect(() => {
    // Other pages need an account: back to the chat home with the sign-in popup, then on to the page.
    if (status === 'signed-out' && !isPublic && !isHome) {
      router.replace(`/?${new URLSearchParams({ auth: 'login', next: window.location.pathname + window.location.search })}`);
    }
    if (status === 'signed-in' && guestOnly) {
      router.replace(safeNext(new URLSearchParams(window.location.search).get('next')));
    }
  }, [status, isPublic, isHome, guestOnly, router]);

  if (isPublic) return status === 'signed-in' && guestOnly ? <FullPageSpinner /> : children;
  if (status === 'loading') return <FullPageSpinner />;
  if (status === 'signed-out') return isHome ? <Shell guest>{children}</Shell> : <FullPageSpinner />;
  if (!user.email_verified) return <VerifyEmailGate />;
  return <Shell>{children}</Shell>;
}

export default function AppShell({ children }) {
  return (
    <AuthProvider>
      <AuthModalProvider>
        <Gate>{children}</Gate>
      </AuthModalProvider>
    </AuthProvider>
  );
}
