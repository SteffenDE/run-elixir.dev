// node:zlib by fflate: gzip, deflate (zlib's format) and raw deflate, and
// unzip (gzip or zlib, whichever it is), synchronous, with callbacks and as
// streams. Brotli is named, and says it is missing when called.
import * as fflate from 'fflate';
import * as streams from 'readable-stream';
import { Buffer } from './buffer';

const { Transform } = streams as typeof import('node:stream');

type Input = string | ArrayBuffer | ArrayBufferView;
type Options = { level?: number; mem?: number } & Record<string, unknown>;
type Callback = (error: Error | null, result?: Buffer) => void;

export const constants = {
  Z_NO_FLUSH: 0,
  Z_PARTIAL_FLUSH: 1,
  Z_SYNC_FLUSH: 2,
  Z_FULL_FLUSH: 3,
  Z_FINISH: 4,
  Z_BLOCK: 5,
  Z_OK: 0,
  Z_STREAM_END: 1,
  Z_NEED_DICT: 2,
  Z_ERRNO: -1,
  Z_STREAM_ERROR: -2,
  Z_DATA_ERROR: -3,
  Z_MEM_ERROR: -4,
  Z_BUF_ERROR: -5,
  Z_VERSION_ERROR: -6,
  Z_NO_COMPRESSION: 0,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_COMPRESSION: -1,
  Z_FILTERED: 1,
  Z_HUFFMAN_ONLY: 2,
  Z_RLE: 3,
  Z_FIXED: 4,
  Z_DEFAULT_STRATEGY: 0,
  Z_DEFAULT_WINDOWBITS: 15,
  Z_DEFAULT_MEMLEVEL: 8,
  Z_DEFAULT_CHUNK: 16384,
  BROTLI_OPERATION_PROCESS: 0,
  BROTLI_OPERATION_FLUSH: 1,
  BROTLI_OPERATION_FINISH: 2,
  BROTLI_OPERATION_EMIT_METADATA: 3,
  BROTLI_PARAM_MODE: 0,
  BROTLI_MODE_GENERIC: 0,
  BROTLI_MODE_TEXT: 1,
  BROTLI_MODE_FONT: 2,
  BROTLI_PARAM_QUALITY: 1,
  BROTLI_MIN_QUALITY: 0,
  BROTLI_MAX_QUALITY: 11,
  BROTLI_DEFAULT_QUALITY: 11,
  BROTLI_PARAM_LGWIN: 2,
  BROTLI_PARAM_SIZE_HINT: 5,
};

const bytes = (input: Input): Uint8Array =>
  typeof input === 'string'
    ? new TextEncoder().encode(input)
    : input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);

const buffer = (data: Uint8Array) => Buffer.from(data.buffer, data.byteOffset, data.byteLength);

// fflate's level: zlib's -1 is its default (6).
const level = (options?: Options) =>
  (options?.level === undefined || options.level < 0 ? 6 : Math.min(9, options.level)) as
    | 0
    | 1
    | 2
    | 3
    | 4
    | 5
    | 6
    | 7
    | 8
    | 9;

const zlibError = (message: string, errno = -3, code = 'Z_DATA_ERROR') =>
  Object.assign(new Error(message), { errno, code });
const short = () => zlibError('unexpected end of file', -5, 'Z_BUF_ERROR');

// What a corrupt or truncated input throws, as zlib's (fflate's code 0 is
// its unexpected EOF).
const failed = (error: unknown) => {
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') return error as Error;
  if (code === 0) return short();
  return zlibError((error as Error).message || 'invalid compressed data');
};

// gzip's members one after another, as zlib's gunzip reads them: each
// inflated, and its end found by its trailer (its data's CRC and size);
// what follows a zero byte is ignored.
function gunzip(data: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [];
  let at = 0;
  do {
    const start = at + gzipHeader(data.subarray(at));
    const inflated = fflate.inflateSync(data.subarray(start));
    const crc = crc32(inflated);
    const size = inflated.length;
    const trailer = [
      crc,
      crc >>> 8,
      crc >>> 16,
      crc >>> 24,
      size,
      size >>> 8,
      size >>> 16,
      size >>> 24,
    ];
    let end = start;
    while (end + 8 <= data.length && trailer.some((b, i) => data[end + i] !== (b & 0xff))) end++;
    if (end + 8 > data.length) throw short();
    out.push(inflated);
    at = end + 8;
  } while (at < data.length && data[at] !== 0);
  return out.length === 1 ? out[0] : Buffer.concat(out);
}

// zlib's format, a header too short or wrong as zlib's says it.
function unzlib(data: Uint8Array): Uint8Array {
  if (data.length < 2) throw short();
  if ((data[0] & 15) !== 8 || data[0] >> 4 > 7 || ((data[0] << 8) | data[1]) % 31)
    throw zlibError('incorrect header check');
  // Its header, an empty block and its checksum at least.
  if (data.length < 8) throw short();
  return fflate.unzlibSync(data);
}

// A gzip header's length.
function gzipHeader(data: Uint8Array): number {
  if ([0x1f, 0x8b].some((b, i) => i < data.length && data[i] !== b))
    throw zlibError('incorrect header check');
  if (data.length > 2 && data[2] !== 8) throw zlibError('unknown compression method');
  if (data.length < 10) throw short();
  const flags = data[3];
  let n = 10;
  if (flags & 4) n += 2 + (data[10] | (data[11] << 8));
  if (flags & 8) while (n < data.length && data[n++]);
  if (flags & 16) while (n < data.length && data[n++]);
  if (flags & 2) n += 2;
  if (n >= data.length) throw short();
  return n;
}

const sync = {
  gzipSync: (input: Input, options?: Options) =>
    buffer(fflate.gzipSync(bytes(input), { level: level(options) })),
  deflateSync: (input: Input, options?: Options) =>
    buffer(fflate.zlibSync(bytes(input), { level: level(options) })),
  deflateRawSync: (input: Input, options?: Options) =>
    buffer(fflate.deflateSync(bytes(input), { level: level(options) })),
  gunzipSync: (input: Input) => buffer(gunzip(bytes(input))),
  inflateSync: (input: Input) => buffer(unzlib(bytes(input))),
  inflateRawSync: (input: Input) => buffer(fflate.inflateSync(bytes(input))),
  unzipSync: (input: Input) => {
    const data = bytes(input);
    return buffer(data[0] === 0x1f && data[1] === 0x8b ? gunzip(data) : unzlib(data));
  },
};

const guarded =
  (f: (input: Input, options?: Options) => Buffer) => (input: Input, options?: Options) => {
    try {
      return f(input, options);
    } catch (error) {
      throw failed(error);
    }
  };

// The callback form: f(input, [options], callback), answered later.
const later =
  (f: (input: Input, options?: Options) => Buffer) =>
  (input: Input, options?: Options | Callback, callback?: Callback) => {
    if (typeof options === 'function') [callback, options] = [options, undefined];
    setTimeout(() => {
      let result: Buffer;
      try {
        result = f(input, options as Options | undefined);
      } catch (error) {
        return callback?.(failed(error));
      }
      callback?.(null, result);
    }, 0);
  };

type Streamer = {
  push(chunk: Uint8Array, final?: boolean): void;
  ondata: (data: Uint8Array, final: boolean) => void;
  // A compressor's: what it holds, out now.
  flush?(): void;
};

// A Transform over one of fflate's streams, as a class named `name`.
function transform(name: string, make: (options?: Options) => Streamer) {
  class Zlib extends Transform {
    declare engine: Streamer;
    bytesWritten = 0;
    constructor(options?: Options) {
      super();
      this.engine = make(options);
      this.engine.ondata = (data) => {
        if (data.length) this.push(buffer(data));
      };
    }
    _transform(chunk: Uint8Array, _encoding: string, done: (error?: Error | null) => void) {
      try {
        this.engine.push(bytes(chunk));
      } catch (error) {
        return done(failed(error));
      }
      done();
    }
    _flush(done: (error?: Error | null) => void) {
      try {
        this.engine.push(new Uint8Array(0), true);
      } catch (error) {
        return done(failed(error));
      }
      done();
    }
    close(callback?: () => void) {
      this.destroy();
      callback?.();
    }
    // flush([kind], [callback]): after what is written so far.
    flush(kind?: number | (() => void), callback?: () => void) {
      if (typeof kind === 'function') callback = kind;
      const done = () => callback?.();
      if (this.writableFinished) return queueMicrotask(done);
      if (this.writableEnded) return void this.once('end', done);
      this.write(new Uint8Array(0), () => {
        this.engine.flush?.();
        done();
      });
    }
    params(_level: number, _strategy: number, callback?: () => void) {
      callback?.();
    }
    reset() {}
  }
  Object.defineProperty(Zlib, 'name', { value: name });
  return Zlib;
}

// fflate's Gunzip, the last member's trailer checked at the end: what a
// truncated input lacks.
function gunzipStream(): Streamer {
  const engine = new fflate.Gunzip();
  let crc = 0;
  let size = 0;
  let tail = new Uint8Array(0);
  const streamer: Streamer = {
    ondata: () => {},
    push(chunk, final) {
      const joined = new Uint8Array(tail.length + chunk.length);
      joined.set(tail);
      joined.set(chunk, tail.length);
      tail = joined.slice(-8);
      engine.push(chunk, final);
      if (!final) return;
      const trailer = [crc, crc >>> 8, crc >>> 16, crc >>> 24, size, size >>> 8, size >>> 16];
      if (tail.length < 8 || [...trailer, size >>> 24].some((b, i) => tail[i] !== (b & 0xff)))
        throw short();
    },
  };
  engine.ondata = (data, final) => {
    crc = crc32(data, crc);
    size += data.length;
    streamer.ondata(data, final);
  };
  engine.onmember = () => {
    crc = 0;
    size = 0;
  };
  return streamer;
}

const classes = {
  Gzip: transform('Gzip', (o) => new fflate.Gzip({ level: level(o) })),
  Gunzip: transform('Gunzip', gunzipStream),
  Deflate: transform('Deflate', (o) => new fflate.Zlib({ level: level(o) })),
  Inflate: transform('Inflate', () => new fflate.Unzlib()),
  DeflateRaw: transform('DeflateRaw', (o) => new fflate.Deflate({ level: level(o) })),
  InflateRaw: transform('InflateRaw', () => new fflate.Inflate()),
  Unzip: transform('Unzip', () => new fflate.Decompress()),
};

const compressors = {
  createGzip: (o?: Options) => new classes.Gzip(o),
  createGunzip: (o?: Options) => new classes.Gunzip(o),
  createDeflate: (o?: Options) => new classes.Deflate(o),
  createInflate: (o?: Options) => new classes.Inflate(o),
  createDeflateRaw: (o?: Options) => new classes.DeflateRaw(o),
  createInflateRaw: (o?: Options) => new classes.InflateRaw(o),
  createUnzip: (o?: Options) => new classes.Unzip(o),
};

const brotli = () => {
  throw Object.assign(new Error('zlib: brotli is not available in the playground yet'), {
    code: 'ERR_NOT_AVAILABLE',
  });
};

// CRC-32, as zlib's crc32(data, value).
let table: Uint32Array | null = null;
function crc32(data: Input, value = 0): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = (value ^ 0xffffffff) >>> 0;
  for (const byte of bytes(data)) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function createZlib() {
  const syncs = Object.fromEntries(
    Object.entries(sync).map(([name, f]) => [name, guarded(f)]),
  ) as typeof sync;
  return {
    ...syncs,
    gzip: later(syncs.gzipSync),
    gunzip: later(syncs.gunzipSync),
    deflate: later(syncs.deflateSync),
    inflate: later(syncs.inflateSync),
    deflateRaw: later(syncs.deflateRawSync),
    inflateRaw: later(syncs.inflateRawSync),
    unzip: later(syncs.unzipSync),
    ...compressors,
    ...classes,
    brotliCompressSync: brotli,
    brotliDecompressSync: brotli,
    brotliCompress: (_input: Input, options?: unknown, callback?: Callback) =>
      setTimeout(() => {
        try {
          brotli();
        } catch (error) {
          (typeof options === 'function' ? (options as Callback) : callback)?.(error as Error);
        }
      }, 0),
    brotliDecompress: (_input: Input, options?: unknown, callback?: Callback) =>
      setTimeout(() => {
        try {
          brotli();
        } catch (error) {
          (typeof options === 'function' ? (options as Callback) : callback)?.(error as Error);
        }
      }, 0),
    createBrotliCompress: brotli,
    createBrotliDecompress: brotli,
    crc32,
    constants,
    codes: { Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_DATA_ERROR: -3, Z_BUF_ERROR: -5 },
    ...Object.fromEntries(Object.entries(constants).filter(([k]) => k.startsWith('Z_'))),
  };
}
