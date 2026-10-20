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

// What a corrupt or truncated input throws, as zlib's.
const failed = (error: unknown) =>
  Object.assign(new Error((error as Error).message || 'invalid compressed data'), {
    errno: -3,
    code: 'Z_DATA_ERROR',
  });

const sync = {
  gzipSync: (input: Input, options?: Options) =>
    buffer(fflate.gzipSync(bytes(input), { level: level(options) })),
  deflateSync: (input: Input, options?: Options) =>
    buffer(fflate.zlibSync(bytes(input), { level: level(options) })),
  deflateRawSync: (input: Input, options?: Options) =>
    buffer(fflate.deflateSync(bytes(input), { level: level(options) })),
  gunzipSync: (input: Input) => buffer(fflate.gunzipSync(bytes(input))),
  inflateSync: (input: Input) => buffer(fflate.unzlibSync(bytes(input))),
  inflateRawSync: (input: Input) => buffer(fflate.inflateSync(bytes(input))),
  unzipSync: (input: Input) => buffer(fflate.decompressSync(bytes(input))),
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
};

// A Transform over one of fflate's streams.
function transform(make: (options?: Options) => Streamer) {
  return (options?: Options) => {
    const engine = make(options);
    const stream = new Transform({
      transform(chunk: Uint8Array, _encoding: string, done: (error?: Error | null) => void) {
        try {
          engine.push(bytes(chunk));
        } catch (error) {
          return done(failed(error));
        }
        done();
      },
      flush(done: (error?: Error | null) => void) {
        try {
          engine.push(new Uint8Array(0), true);
        } catch (error) {
          return done(failed(error));
        }
        done();
      },
    });
    engine.ondata = (data) => {
      if (data.length) stream.push(buffer(data));
    };
    return Object.assign(stream, {
      bytesWritten: 0,
      close: (callback?: () => void) => {
        stream.destroy();
        callback?.();
      },
      flush: (_kind?: number, callback?: () => void) => callback?.(),
      params: (_level: number, _strategy: number, callback?: () => void) => callback?.(),
      reset() {},
    });
  };
}

const compressors = {
  createGzip: transform((o) => new fflate.Gzip({ level: level(o) })),
  createGunzip: transform(() => new fflate.Gunzip()),
  createDeflate: transform((o) => new fflate.Zlib({ level: level(o) })),
  createInflate: transform(() => new fflate.Unzlib()),
  createDeflateRaw: transform((o) => new fflate.Deflate({ level: level(o) })),
  createInflateRaw: transform(() => new fflate.Inflate()),
  createUnzip: transform(() => new fflate.Decompress()),
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
    Gzip: compressors.createGzip,
    Gunzip: compressors.createGunzip,
    Deflate: compressors.createDeflate,
    Inflate: compressors.createInflate,
    DeflateRaw: compressors.createDeflateRaw,
    InflateRaw: compressors.createInflateRaw,
    Unzip: compressors.createUnzip,
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
