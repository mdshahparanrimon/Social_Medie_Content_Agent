'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { AccentPicker, ModeSwitch } from '@/components/theme';
import { AuthProvider, safeNext, UserAvatar, useAuth } from '@/components/auth';
import { FullPageSpinner } from '@/components/AuthLayout';
import VerifyEmailGate from '@/components/VerifyEmailGate';

const ICON_PATHS = {
  dashboard: 'M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
  posts: 'M4 4h16v16H4zM8 9h8M8 13h8M8 17h5',
  instant: 'M13 2 4 14h7l-1 8 9-12h-7l1-8Z',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  brand: 'M12 3a6 6 0 0 0-6 6c0 2.2 1.2 3.6 2.3 4.7.8.8 1.2 1.6 1.2 2.6V17h5v-.7c0-1 .4-1.8 1.2-2.6C16.8 12.6 18 11.2 18 9a6 6 0 0 0-6-6ZM9.5 21h5',
  connections: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-4l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  chevron: 'm7 15 5 5 5-5M7 9l5-5 5 5',
};

export function Icon({ name, className = 'size-[18px]' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

const GROUPS = [
  {
    title: 'Workspace',
    links: [
      { href: '/', label: 'Dashboard', icon: 'dashboard' },
      { href: '/calendar', label: 'Calendar', icon: 'calendar' },
      { href: '/posts', label: 'Posts', icon: 'posts' },
      { href: '/instant', label: 'Instant', icon: 'instant' },
    ],
  },
  {
    title: 'Setup',
    links: [
      { href: '/brand', label: 'Brand Brain', icon: 'brand' },
      { href: '/connections', label: 'Connections', icon: 'connections' },
      { href: '/settings', label: 'Settings', icon: 'settings' },
    ],
  },
  { title: 'Admin', admin: true, links: [{ href: '/admin/users', label: 'Users', icon: 'users' }] },
];

const ALL_LINKS = [...GROUPS.flatMap((g) => g.links), { href: '/account', label: 'Account', icon: 'user' }];
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

function UserMenu({ onNavigate }) {
  const { user, logout } = useAuth();
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

  return (
    <div ref={ref} className="relative">
      {open && (
        <div role="menu" className="absolute inset-x-0 bottom-full mb-2 overflow-hidden rounded-lg border border-zinc-200 bg-surface py-1 shadow-lg">
          <div className="border-b border-zinc-200 px-3 py-2">
            <div className="truncate text-xs text-zinc-500">Signed in as</div>
            <div className="truncate text-sm font-medium text-zinc-900">{user.email}</div>
          </div>
          <Link
            href="/account"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onNavigate?.();
            }}
            className="flex items-center gap-2.5 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
          >
            <Icon name="user" className="size-4" /> Account settings
          </Link>
          <button role="menuitem" onClick={signOut} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50">
            <Icon name="logout" className="size-4" /> Sign out
          </button>
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center gap-3 rounded-lg border border-zinc-200 bg-surface p-2 text-left transition hover:bg-zinc-50"
      >
        <UserAvatar user={user} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-zinc-900">{user.name}</span>
          <span className="block truncate text-xs text-zinc-500">{user.role === 'admin' ? 'Owner · Admin' : user.workspace?.name}</span>
        </span>
        <Icon name="chevron" className="size-4 text-zinc-400" />
      </button>
    </div>
  );
}

function SidebarContent({ pathname, onNavigate }) {
  const { isAdmin } = useAuth();
  return (
    <div className="flex h-full flex-col gap-6 px-3 py-5">
      <Logo />
      <nav className="flex-1 space-y-6 overflow-y-auto">
        {GROUPS.filter((group) => !group.admin || isAdmin).map((group) => (
          <div key={group.title}>
            <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{group.title}</p>
            <ul className="space-y-0.5">
              {group.links.map(({ href, label, icon }) => {
                const active = isActive(href, pathname);
                return (
                  <li key={href}>
                    <Link
                      href={href}
                      onClick={onNavigate}
                      aria-current={active ? 'page' : undefined}
                      className={`relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition ${
                        active ? 'bg-accent-50 text-accent-700' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
                      }`}
                    >
                      {active && <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent-600" />}
                      <Icon name={icon} />
                      {label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="space-y-3">
        <div className="space-y-3 rounded-lg border border-zinc-200 bg-surface p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-500">Theme</span>
            <ModeSwitch />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-500">Accent</span>
            <AccentPicker />
          </div>
        </div>
        <UserMenu onNavigate={onNavigate} />
      </div>
    </div>
  );
}

function Shell({ children }) {
  const pathname = usePathname();
  const { isAdmin } = useAuth();
  const [open, setOpen] = useState(false);
  const current = ALL_LINKS.find((l) => isActive(l.href, pathname));
  const forbidden = pathname.startsWith('/admin') && !isAdmin;

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
        <SidebarContent pathname={pathname} />
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto border-r border-zinc-200 bg-sidebar shadow-xl">
            <SidebarContent pathname={pathname} onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}

      <header className="sticky top-0 z-30 border-b border-zinc-200 bg-surface/85 backdrop-blur">
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
            <ModeSwitch />
            <Link
              href="/instant"
              className="hidden items-center gap-1.5 rounded-md bg-accent-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-accent-700 dark:hover:bg-accent-600 dark:hover:brightness-110 sm:inline-flex"
            >
              <Icon name="instant" className="size-4" />
              New post
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
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

// Decides what to show: the public auth pages, the login redirect, the verify-email screen, or the app.
function Gate({ children }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, status } = useAuth();
  const isPublic = PUBLIC_ROUTES.some((r) => pathname.startsWith(r));
  const guestOnly = GUEST_ONLY.some((r) => pathname.startsWith(r));

  useEffect(() => {
    if (status === 'signed-out' && !isPublic) {
      const here = window.location.pathname + window.location.search;
      router.replace(here === '/' ? '/login' : `/login?${new URLSearchParams({ next: here })}`);
    }
    if (status === 'signed-in' && guestOnly) {
      router.replace(safeNext(new URLSearchParams(window.location.search).get('next')));
    }
  }, [status, isPublic, guestOnly, router]);

  if (isPublic) return status === 'signed-in' && guestOnly ? <FullPageSpinner /> : children;
  if (status !== 'signed-in') return <FullPageSpinner />;
  if (!user.email_verified) return <VerifyEmailGate />;
  return <Shell>{children}</Shell>;
}

export default function AppShell({ children }) {
  return (
    <AuthProvider>
      <Gate>{children}</Gate>
    </AuthProvider>
  );
}
