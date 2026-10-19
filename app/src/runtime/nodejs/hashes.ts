// crypto's hashes, synchronous as Node's are (WebCrypto's digest is not):
// createHash, createHmac and hash, by @noble/hashes.
import { Buffer } from './buffer';
import { hmac } from '@noble/hashes/hmac.js';
import { md5, ripemd160, sha1 } from '@noble/hashes/legacy.js';
import { sha224, sha256, sha384, sha512 } from '@noble/hashes/sha2.js';

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

// A hash or HMAC under way: update() and then one digest().
class Hash {
  declare state: State;
  declare done: boolean;
  constructor(state: State) {
    this.state = state;
    this.done = false;
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
  // As a stream: written data is hashed, read() gives the digest.
  write(data: string | ArrayBufferView, encoding?: BufferEncoding) {
    this.update(data, encoding);
    return true;
  }
  end(data?: string | ArrayBufferView, encoding?: BufferEncoding) {
    if (data !== undefined) this.update(data, encoding);
  }
  read() {
    return this.done ? null : this.digest();
  }
}

export const hashes = {
  createHash: (name: string) => new Hash(algorithm(name).create()),
  createHmac: (name: string, key: string | ArrayBufferView) =>
    new Hash(hmac.create(algorithm(name) as never, bytes(key)) as unknown as State),
  // crypto.hash(algorithm, data, encoding = 'hex'): one digest at once.
  hash: (name: string, data: string | ArrayBufferView, encoding: BufferEncoding = 'hex') =>
    output(algorithm(name)(bytes(data)), encoding),
  getHashes: () => Object.keys(ALGORITHMS),
};
