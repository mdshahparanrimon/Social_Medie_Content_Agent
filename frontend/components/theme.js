'use client';

import { useEffect, useSyncExternalStore } from 'react';

export const MODES = [
  { key: 'light', label: 'Light' },
  { key: 'dark', label: 'Dark' },
  { key: 'system', label: 'System' },
];

export const ACCENTS = [
  { key: 'indigo', label: 'Indigo', swatch: 'oklch(51.1% 0.262 277)' },
  { key: 'blue', label: 'Blue', swatch: 'oklch(54.6% 0.245 262.9)' },
  { key: 'violet', label: 'Violet', swatch: 'oklch(54.1% 0.281 293)' },
  { key: 'rose', label: 'Rose', swatch: 'oklch(58.6% 0.253 17.6)' },
  { key: 'teal', label: 'Teal', swatch: 'oklch(60% 0.118 184.7)' },
];

const DEFAULTS = { mode: 'system', accent: 'indigo' };
const STORAGE_KEY = 'content-agent-theme';

// Runs in <head> before first paint so the page never flashes the wrong theme.
export const themeInitScript = `(function(){try{var t=JSON.parse(localStorage.getItem('${STORAGE_KEY}')||'{}');var m=t.mode||'${DEFAULTS.mode}';var d=m==='dark'||(m==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;r.classList.toggle('dark',d);r.dataset.accent=t.accent||'${DEFAULTS.accent}';}catch(e){}})();`;

function read() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
  } catch {
    return DEFAULTS;
  }
}

let state = DEFAULTS;
const listeners = new Set();

function apply() {
  const dark = state.mode === 'dark' || (state.mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.dataset.accent = state.accent;
}

function subscribe(listener) {
  if (listeners.size === 0) state = read();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setTheme(patch) {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
  apply();
  listeners.forEach((l) => l());
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, () => state, () => DEFAULTS);

  // Follow the OS while in System mode.
  useEffect(() => {
    if (theme.mode !== 'system') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme.mode]);

  return theme;
}

const ICONS = {
  light: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  dark: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  system: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
};

export function ModeSwitch({ showLabels = false }) {
  const { mode } = useTheme();
  return (
    <div role="radiogroup" aria-label="Color mode" className="inline-flex rounded-lg border border-zinc-200 bg-zinc-100 p-0.5">
      {MODES.map((m) => (
        <button
          key={m.key}
          role="radio"
          aria-checked={mode === m.key}
          title={m.label}
          onClick={() => setTheme({ mode: m.key })}
          className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition ${
            mode === m.key ? 'bg-surface text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-800'
          }`}
        >
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            {ICONS[m.key]}
          </svg>
          {showLabels && m.label}
        </button>
      ))}
    </div>
  );
}

export function AccentPicker() {
  const { accent } = useTheme();
  return (
    <div role="radiogroup" aria-label="Accent color" className="flex items-center gap-2">
      {ACCENTS.map((a) => (
        <button
          key={a.key}
          role="radio"
          aria-checked={accent === a.key}
          title={a.label}
          onClick={() => setTheme({ accent: a.key })}
          className={`size-6 rounded-full ring-offset-2 ring-offset-surface transition ${
            accent === a.key ? 'ring-2 ring-zinc-900' : 'hover:scale-110'
          }`}
          style={{ background: a.swatch }}
        />
      ))}
    </div>
  );
}
