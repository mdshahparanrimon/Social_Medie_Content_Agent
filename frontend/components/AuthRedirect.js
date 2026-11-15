'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Old /login and /signup links (emails, Google/LinkedIn errors, bookmarks) open the sign-in popup on the home page.
export default function AuthRedirect({ mode }) {
  const router = useRouter();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    params.set('auth', mode);
    router.replace(`/?${params}`);
  }, [mode, router]);
  return null;
}
