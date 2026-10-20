import { AsyncLocalStorage } from 'node:async_hooks';

// The workspace a request (or a scheduler job) acts for. Every workspace-owned query in the
// repository reads it from here, so data can't leak between customers by a forgotten filter.
const storage = new AsyncLocalStorage();

export function runInWorkspace(workspaceId, fn) {
  return storage.run({ workspaceId: String(workspaceId) }, fn);
}

export function workspaceId() {
  const id = storage.getStore()?.workspaceId;
  if (!id) throw new Error('No workspace in context: this code must run inside runInWorkspace().');
  return id;
}

export const hasWorkspace = () => Boolean(storage.getStore()?.workspaceId);
