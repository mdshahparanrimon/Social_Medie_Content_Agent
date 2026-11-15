// The sidebar lists chats and highlights the open one; the chat page tells it when either changes.
export const CHAT_EVENT = 'chat:changed';

// activeId: the open conversation (null = a new, unsaved chat).
export function notifyChats(activeId) {
  window.dispatchEvent(new CustomEvent(CHAT_EVENT, { detail: { activeId } }));
}
