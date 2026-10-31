// crypto's hashes, synchronous as Node's are (WebCrypto's digest is not):
// createHash, createHmac and hash, by @noble/hashes.
import { Buffer } from './buffer';
import * as streams from 'readable-stream';
import { hmac } from '@noble/hashes/hmac.js';
import { md5, ripemd160, sha1 } from '@noble/hashes/legacy.js';
import { sha224, sha256, sha384, sha512 } from '@noble/hashes/sha2.js';

const { Transform } = streams as typeof import('node:stream');

interface State {
  update(data: Uint8Array): unknown;
  digest(): Uint8Array;
  clone(): State;
}
interface Hasher {
  (data: Uint8Array): Uint8Array;
  create(): State;
}

const ALGORITHMS = {
  md5,
  sha1,
  ripemd160,
  sha224,
  sha256,
  sha384,
  sha512,
} as unknown as Record<string, Hasher>;

function algorithm(name: string): Hasher {
  const hasher = ALGORITHMS[name.toLowerCase().replace(/^rsa-/, '').replace(/^sha-/, 'sha')];
  if (!hasher)
    throw Object.assign(new Error(`Digest method not supported: ${name}`), {
      code: 'ERR_CRYPTO_INVALID_DIGEST',
    });
  return hasher;
}

const bytes = (data: string | ArrayBufferView | ArrayBuffer, encoding?: BufferEncoding) =>
  typeof data === 'string'
    ? Buffer.from(data, encoding ?? 'utf8')
    : data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

const output = (digest: Uint8Array, encoding?: BufferEncoding) => {
  const buffer = Buffer.from(digest);
  return encoding && encoding !== ('buffer' as BufferEncoding) ? buffer.toString(encoding) : buffer;
};

// A hash or HMAC under way: update() and then one digest(). As a stream,
// what is written is hashed, and the digest is read at its end.
class Hash extends Transform {
  declare state: State;
  declare done: boolean;
  constructor(state: State) {
    super();
    this.state = state;
    this.done = false;
  }
  _transform(chunk: Uint8Array, _encoding: string, callback: (error?: Error | null) => void) {
    this.state.update(bytes(chunk));
    callback();
  }
  _flush(callback: (error?: Error | null) => void) {
    this.push(this.digest());
    callback();
  }
  update(data: string | ArrayBufferView, encoding?: BufferEncoding) {
    if (this.done)
      throw Object.assign(new Error('Digest already called'), {
        code: 'ERR_CRYPTO_HASH_FINALIZED',
      });
    this.state.update(bytes(data, encoding));
    return this;
  }
  digest(encoding?: BufferEncoding) {
    // An HMAC's second is empty.
    if (this.done && this instanceof Hmac) return output(new Uint8Array(0), encoding);
    if (this.done)
      throw Object.assign(new Error('Digest already called'), {
        code: 'ERR_CRYPTO_HASH_FINALIZED',
      });
    this.done = true;
    return output(this.state.digest(), encoding);
  }
  copy() {
    return new Hash(this.state.clone());
  }
}

class Hmac extends Hash {}

export const hashes = {
  createHash: (name: string) => new Hash(algorithm(name).create()),
  createHmac: (name: string, key: string | ArrayBufferView) =>
    new Hmac(hmac.create(algorithm(name) as never, bytes(key)) as unknown as State),
  // crypto.hash(algorithm, data, encoding = 'hex'): one digest at once.
  hash: (name: string, data: string | ArrayBufferView, encoding: BufferEncoding = 'hex') =>
    output(algorithm(name)(bytes(data)), encoding),
  getHashes: () => Object.keys(ALGORITHMS),
};
