import { newId } from '@/shared/lib/ids';
import { previewOrigin } from '@/shared/lib/site';

// The IDE and a popped-out preview (preview.html) talk over this channel.
export type PreviewMessage =
  | { type: 'reload' }
  | { type: 'css' }
  | { type: 'navigate'; path: string }
  // The port the preview shows (the IDE's bridge has it), for its path bar.
  | { type: 'port'; port: number | null }
  | { type: 'opened' }
  | { type: 'closed' };

// One channel per project, and its preview's origins (site.ts
// previewOrigins): a stored project's id, a temporary IEx's own (an id as
// a project's, kept nowhere). The popped-out window gets the key in its
// URL. The IDE's page takes the key of each project it opens
// (setPreviewKey: it goes from one to another in place, navigate.ts).
const keyOf = () =>
  new URLSearchParams(location.search).get('key') ??
  location.pathname.match(/^\/([a-z0-9]{10})\//)?.[1] ??
  newId();
export let previewKey = keyOf();
export let previewChannel = new BroadcastChannel(`playground-preview:${previewKey}`);
// What hears the channel, whichever project's it is.
const listeners = new Set<(event: MessageEvent<PreviewMessage>) => void>();
previewChannel.onmessage = (event) => listeners.forEach((listener) => listener(event));

export function onPreviewMessage(listener: (event: MessageEvent<PreviewMessage>) => void): void {
  listeners.add(listener);
}

// The project now on the page (from its URL): its key and channel.
export function setPreviewKey(): void {
  const key = keyOf();
  if (key === previewKey) return;
  previewChannel.close();
  previewKey = key;
  previewChannel = new BroadcastChannel(`playground-preview:${previewKey}`);
  previewChannel.onmessage = (event) => listeners.forEach((listener) => listener(event));
}

// Where the preview shows `port` (site.ts previewOrigin), for PreviewFrame.
export const previewOriginOf = (port: number) => previewOrigin(previewKey, port);

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
