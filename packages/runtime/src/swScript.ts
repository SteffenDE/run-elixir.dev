// The service worker's script stamp (docs/frames.md, "Service worker
// updates"). The build appends a line to sw.js that names the SHA-256 of
// the script before it. The worker reports that hash when it bridges
// (swBridge.ts). The bootstrap (public/root/bridge.html) hashes the /sw.js
// the server sends now, the stamp line taken out: if the two hashes
// match, the browser's update check cannot find a new worker, and the
// bootstrap need not wait for it. The bootstrap has its own copy of
// STAMP, as it imports nothing.
export const STAMP = /\nself\.playgroundScript="([0-9a-f]{64})";\n/;

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// The script with its stamp line at its end.
export async function stamp(code: string): Promise<string> {
  return `${code}\nself.playgroundScript="${await sha256(code)}";\n`;
}

// The hash a stamped script's worker reports for `text`, the script as a
// server sends it: of the script without its stamp line.
export function scriptHash(text: string): Promise<string> {
  return sha256(text.replace(STAMP, ''));
}
