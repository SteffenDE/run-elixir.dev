// A shared project, in a link: what it changed over its template (the
// files it added or changed, whole, and those it removed), its kind and
// name, and the site version it was made on. The link carries it in its
// fragment (/import#DATA), which never reaches a server: JSON, compressed
// (deflate-raw), base64url.
import type { Kind } from '../kinds';

// The template a project was made from: its id (a digest of its files,
// without its build) and what it is (templates.ts).
export interface Template {
  id: string;
  label: string;
}

export interface Shared {
  v: 1;
  kind: Kind;
  name: string;
  // The site version (fs/version) the changes were made over, and the
  // template (since templates have versions).
  site: string;
  template?: Template;
  // Path below /work → text, or { base64 } for bytes that are no UTF-8.
  files: Record<string, string | { base64: string }>;
  removed: string[];
}

const strict = new TextDecoder('utf-8', { fatal: true });

const toBase64 = (bytes: Uint8Array) => {
  let text = '';
  for (let at = 0; at < bytes.length; at += 0x8000)
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export function fileEntry(data: Uint8Array): string | { base64: string } {
  try {
    return strict.decode(data);
  } catch {
    return { base64: toBase64(data) };
  }
}

export function fileBytes(entry: string | { base64: string }): Uint8Array {
  return typeof entry === 'string' ? new TextEncoder().encode(entry) : fromBase64(entry.base64);
}

async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function encodeShared(shared: Shared): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(shared));
  const packed = await through(json, new CompressionStream('deflate-raw'));
  return toBase64(packed).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function decodeShared(data: string): Promise<Shared> {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  const json = await through(fromBase64(base64), new DecompressionStream('deflate-raw'));
  const shared = JSON.parse(new TextDecoder().decode(json)) as Shared;
  if (shared.v !== 1 || !['phoenix', 'empty'].includes(shared.kind))
    throw new Error('This link is not a project this playground knows.');
  return shared;
}
