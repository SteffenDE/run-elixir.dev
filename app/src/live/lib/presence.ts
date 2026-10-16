// This page's cursor, for the others in a live session: the editor says
// where it is, the session (host.ts, guest.ts) sends it, at most every
// 50 ms.
import type { Cursor } from './store';

let sender: ((cursor: Cursor | null) => void) | null = null;
let pending: Cursor | null | undefined;
let timer: ReturnType<typeof setTimeout> | null = null;
let last = '';

export function setCursorSender(send: ((cursor: Cursor | null) => void) | null): void {
  sender = send;
  last = '';
}

export function publishCursor(cursor: Cursor | null): void {
  if (!sender) return;
  pending = cursor;
  timer ??= setTimeout(() => {
    timer = null;
    const key = JSON.stringify(pending ?? null);
    if (key === last) return;
    last = key;
    sender?.(pending ?? null);
  }, 50);
}
