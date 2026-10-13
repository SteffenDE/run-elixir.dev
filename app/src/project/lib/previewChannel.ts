// The IDE and a popped-out preview (preview.html) talk over this channel.
export type PreviewMessage =
  | { type: 'reload' }
  | { type: 'css' }
  | { type: 'navigate'; path: string }
  | { type: 'opened' }
  | { type: 'closed' };

// One channel per project (the service worker routes its preview by the
// same key): a stored project's id, a temporary IEx's own. The popped-out
// window gets the key in its URL.
export const previewKey =
  new URLSearchParams(location.search).get('key') ??
  location.pathname.match(/^\/([a-z0-9]{10})\//)?.[1] ??
  `iex-${crypto.randomUUID()}`;
export const previewChannel = new BroadcastChannel(`playground-preview:${previewKey}`);

export function send(message: PreviewMessage): void {
  previewChannel.postMessage(message);
}

// The popped-out window, while this page opened it.
let popup: Window | null = null;
export function openPopup(url: string): boolean {
  popup = window.open(url, 'playground-preview', 'popup,width=1100,height=800');
  return popup !== null;
}
export function closePopup(): void {
  popup?.close();
  popup = null;
}
