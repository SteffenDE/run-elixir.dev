// The IDE and a popped-out preview (preview.html) talk over this channel.
export type PreviewMessage =
  | { type: 'reload' }
  | { type: 'css' }
  | { type: 'navigate'; path: string }
  | { type: 'opened' }
  | { type: 'closed' };

// One channel per IDE page: the popped-out window gets its key in its URL.
export const previewKey = new URLSearchParams(location.search).get('key') ?? crypto.randomUUID();
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
