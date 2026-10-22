'use client';

import { Toaster as Sonner } from 'sonner';
import { useTheme } from '@/components/theme';

// App-wide toasts (sonner). Follows the app's light/dark mode; call `toast()` from 'sonner' anywhere.
export default function Toaster() {
  const { mode } = useTheme();
  return <Sonner theme={mode} position="bottom-right" richColors closeButton duration={4000} visibleToasts={4} />;
}
