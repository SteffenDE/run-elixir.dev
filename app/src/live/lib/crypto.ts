// A live session's keys (docs/collaboration.md#encryption), all WebCrypto:
// an AES-256-GCM key everyone with the link holds, and the host's Ed25519
// key pair, whose public half is in the link so guests trust only what the
// host signed.
const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let text = '';
  for (let at = 0; at < bytes.length; at += 0x8000)
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}

export const randomId = (bytes: number) =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));

export interface Keys {
  key: CryptoKey;
  verify: CryptoKey;
  // The host's only.
  sign?: CryptoKey;
}

// What the link's fragment carries: k, the AES key; h, the host's public key.
export interface LinkSecrets {
  k: string;
  h: string;
}

// WebKit (on Linux, 2026) fails about one Ed25519 key generation in a
// hundred, with an OperationError; another try makes one.
async function ed25519Pair(): Promise<CryptoKeyPair> {
  for (let tries = 1; ; tries++) {
    try {
      return (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
        'sign',
        'verify',
      ])) as CryptoKeyPair;
    } catch (error) {
      if (tries === 5) throw error;
    }
  }
}

// A host's keys, new; `secrets` for the link, `stored` for a reload.
export async function newKeys(): Promise<{ keys: Keys; secrets: LinkSecrets; stored: StoredKeys }> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const pair = await ed25519Pair();
  const k = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
  const h = toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const stored = { k, h, sign: await crypto.subtle.exportKey('jwk', pair.privateKey) };
  return {
    keys: { key, verify: pair.publicKey, sign: pair.privateKey },
    secrets: { k, h },
    stored,
  };
}

// A host's keys as kept for a reload (sessionStorage).
export interface StoredKeys extends LinkSecrets {
  sign: JsonWebKey;
}

export async function storedKeys(stored: StoredKeys): Promise<Keys> {
  const keys = await linkKeys(stored);
  keys.sign = await crypto.subtle.importKey('jwk', stored.sign, { name: 'Ed25519' }, false, [
    'sign',
  ]);
  return keys;
}

// A guest's keys, from the link.
export async function linkKeys({ k, h }: LinkSecrets): Promise<Keys> {
  const key = await crypto.subtle.importKey('raw', fromBase64Url(k), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  const hostKey = await crypto.subtle.importKey(
    'raw',
    fromBase64Url(h),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  return { key, verify: hostKey };
}

// The fragment of a session's link, and back.
export const fragment = ({ k, h }: LinkSecrets) => `k=${k}&h=${h}`;

export function parseFragment(hash: string): LinkSecrets | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const k = params.get('k');
  const h = params.get('h');
  return k && h && /^[\w-]{43}$/.test(k) && /^[\w-]{43}$/.test(h) ? { k, h } : null;
}

// Sealed: a random 96-bit nonce, then the ciphertext. `aad` binds it to
// its session, sender and sequence number.
export async function seal(
  key: CryptoKey,
  aad: Uint8Array,
  plain: Uint8Array,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad as BufferSource },
    key,
    plain as BufferSource,
  );
  const out = new Uint8Array(12 + sealed.byteLength);
  out.set(iv);
  out.set(new Uint8Array(sealed), 12);
  return out;
}

export async function open(
  key: CryptoKey,
  aad: Uint8Array,
  sealed: Uint8Array,
): Promise<Uint8Array> {
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: sealed.subarray(0, 12) as BufferSource,
      additionalData: aad as BufferSource,
    },
    key,
    sealed.subarray(12) as BufferSource,
  );
  return new Uint8Array(plain);
}

// Signatures are over the data's SHA-256 digest: WebKit (2026) crashes
// its page signing 64 KB or more with Ed25519.
const digest = async (data: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));

export async function sign(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.sign('Ed25519', key, (await digest(data)) as BufferSource),
  );
}

export async function verify(
  key: CryptoKey,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  return crypto.subtle.verify(
    'Ed25519',
    key,
    signature as BufferSource,
    (await digest(data)) as BufferSource,
  );
}

export const utf8 = (text: string) => encoder.encode(text);
