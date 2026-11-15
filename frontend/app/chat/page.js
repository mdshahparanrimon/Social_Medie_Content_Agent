'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// The chat moved to the home page; old /chat?c=… links keep working.
export default function OldChatLink() {
  const router = useRouter();
  useEffect(() => {
    router.replace(`/${window.location.search}`);
  }, [router]);
  return null;
}
