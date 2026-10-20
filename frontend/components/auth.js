'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, AUTH_EXPIRED_EVENT } from '@/lib/api';

const AuthContext = createContext(null);

// The signed-in user for the whole app. status: 'loading' | 'signed-out' | 'signed-in'.
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('loading');

  const signedIn = useCallback((next) => {
    setUser(next);
    setStatus(next ? 'signed-in' : 'signed-out');
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { user: me } = await api('/auth/me');
      signedIn(me);
      return me;
    } catch {
      signedIn(null);
      return null;
    }
  }, [signedIn]);

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    signedIn(null);
  }, [signedIn]);

  useEffect(() => {
    refresh();
    const expired = () => signedIn(null);
    window.addEventListener(AUTH_EXPIRED_EVENT, expired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, expired);
  }, [refresh, signedIn]);

  const value = useMemo(
    () => ({ user, status, isAdmin: user?.role === 'admin', setUser: signedIn, refresh, logout }),
    [user, status, signedIn, refresh, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

// Only relative paths inside the app, so ?next= can't send people to another site.
export const safeNext = (next) => (typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : '/');

export function initials(name = '', email = '') {
  const parts = (name || email).trim().split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

export function UserAvatar({ user, className = 'size-9 text-sm' }) {
  if (user?.avatar_url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={user.avatar_url} alt="" referrerPolicy="no-referrer" className={`${className} shrink-0 rounded-full object-cover`} />;
  }
  return (
    <span className={`${className} grid shrink-0 place-items-center rounded-full bg-accent-100 font-semibold text-accent-700`}>
      {initials(user?.name, user?.email)}
    </span>
  );
}
