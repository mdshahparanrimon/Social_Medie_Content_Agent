import { toast } from 'sonner';

// Shows a { ok, message } result (the shape the settings/connection/account endpoints return) as a toast.
// `id` keeps a repeated notice (e.g. from a redirect, run twice in development) to one toast.
export function notify({ ok, message }, { id } = {}) {
  if (!message) return;
  if (ok) toast.success(message, { id });
  else toast.error(message, { id });
}
