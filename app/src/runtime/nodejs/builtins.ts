// Node's built-in modules by name (require('fs'), import 'node:path'),
// each made on first use. What the playground does not have yet (network,
// child processes, compression) is there, and says so when called.
import { Buffer } from './buffer';
import { EventEmitter, once } from 'events';
import * as stream from 'readable-stream';
import { StringDecoder } from 'string_decoder';
import { hashes } from './hashes';
import { createHttp, METHODS, STATUS_CODES } from './http';
import type { ChildProcesses } from './child';
import type { Net } from './net';
import { createDns } from './dns';
import { createReadline } from './readline';
import { signals } from './signals';
import { createTls } from './tls';
import { createZlib } from './zlib';
import { createUtil, inspect, isDeepStrictEqual, types } from './util';

type Factories = Record<string, () => unknown>;

export const BUILTINS = [
  'assert',
  'assert/strict',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'dns/promises',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'path/posix',
  'path/win32',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'readline/promises',
  'stream',
  'stream/consumers',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'sys',
  'timers',
  'timers/promises',
  'tls',
  'tty',
  'url',
  'util',
  'util/types',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
];

// A module's calls that the playground lacks: each throws, naming it.
function missing(module: string, names: string[], extra: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = { ...extra };
  for (const name of names)
    out[name] = () => {
      const error = new Error(
        `${module}.${name} is not available in the playground yet`,
      ) as Error & { code: string };
      error.code = 'ERR_NOT_AVAILABLE';
      throw error;
    };
  return out;
}

export function createBuiltins(deps: {
  fs: Record<string, unknown>;
  fsPromises: Record<string, unknown>;
  path: Record<string, unknown>;
  process: Record<string, unknown> & EventEmitter;
  console: Record<string, unknown>;
  timers: Record<string, (...args: never[]) => unknown>;
  module: () => Record<string, unknown>;
  env: Record<string, string>;
  // Whether stdout and stderr are the terminal, and whether stdin is.
  tty: boolean;
  stdinTty: boolean;
  // node:wasi (wasi.ts) and worker_threads (threads.ts).
  wasi: () => Record<string, unknown>;
  threads: () => Record<string, unknown>;
  // node:net on the project's TCP (net.ts); a worker thread has none.
  net: Net | null;
  // The site's runtime files (tls.wasm, tls.ts).
  runtime: string;
  // node:child_process (child.ts); a worker thread has none.
  child: ChildProcesses | null;
}) {
  const { process, timers } = deps;
  const warn = (text: string) => (process.stderr as { write(t: string): void }).write(text);
  const util = createUtil(warn);

  const assert = createAssert();
  // http and https, over the process's net (a thread has none).
  let webModules: ReturnType<typeof createHttp> | null = null;
  const web = () => (deps.net ? (webModules ??= createHttp(deps.net)) : null);

  const factories: Factories = {
    assert: () => assert,
    'assert/strict': () => assert.strict,
    async_hooks: () => {
      class AsyncLocalStorage<T> {
        private store: T | undefined;
        getStore() {
          return this.store;
        }
        run<R>(store: T, fn: (...args: unknown[]) => R, ...args: unknown[]): R {
          const previous = this.store;
          this.store = store;
          try {
            return fn(...args);
          } finally {
            this.store = previous;
          }
        }
        enterWith(store: T) {
          this.store = store;
        }
        exit<R>(fn: (...args: unknown[]) => R, ...args: unknown[]): R {
          return this.run(undefined as T, fn, ...args);
        }
        disable() {
          this.store = undefined;
        }
        static bind = <F>(fn: F) => fn;
        static snapshot =
          () =>
          (fn: (...a: unknown[]) => unknown, ...args: unknown[]) =>
            fn(...args);
      }
      class AsyncResource {
        constructor(public type: string) {}
        runInAsyncScope<R>(fn: (...a: unknown[]) => R, self?: unknown, ...args: unknown[]): R {
          return fn.apply(self, args);
        }
        bind<F>(fn: F) {
          return fn;
        }
        emitDestroy() {
          return this;
        }
        asyncId = () => 1;
        triggerAsyncId = () => 0;
        static bind = <F>(fn: F) => fn;
      }
      return {
        AsyncLocalStorage,
        AsyncResource,
        createHook: () => ({
          enable() {
            return this;
          },
          disable() {
            return this;
          },
        }),
        executionAsyncId: () => 1,
        triggerAsyncId: () => 0,
        executionAsyncResource: () => ({}),
      };
    },
    buffer: () => ({
      Buffer,
      Blob,
      File: globalThis.File,
      constants: { MAX_LENGTH: 2 ** 32, MAX_STRING_LENGTH: 2 ** 29 - 24 },
      kMaxLength: 2 ** 32,
      atob,
      btoa,
      isUtf8: (bytes: Uint8Array) => {
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          return true;
        } catch {
          return false;
        }
      },
      isAscii: (bytes: Uint8Array) => bytes.every((b) => b < 128),
    }),
    child_process: () =>
      deps.child?.module ??
      missing('child_process', [
        'spawn',
        'exec',
        'execFile',
        'fork',
        'spawnSync',
        'execSync',
        'execFileSync',
      ]),
    cluster: () => ({
      isPrimary: true,
      isMaster: true,
      isWorker: false,
      workers: {},
      ...missing('cluster', ['fork', 'setupPrimary']),
    }),
    console: () => deps.console,
    constants: () => ({ ...osConstants.signals, ...(deps.fs.constants as object) }),
    crypto: () => createCrypto(),
    dgram: () => deps.net?.dgram ?? missing('dgram', ['createSocket']),
    diagnostics_channel: () => {
      const channel = (name: string) => ({
        name,
        hasSubscribers: false,
        publish() {},
        subscribe() {},
        unsubscribe: () => true,
        bindStore() {},
        unbindStore() {},
        runStores: (
          _data: unknown,
          fn: (...a: unknown[]) => unknown,
          self: unknown,
          ...args: unknown[]
        ) => fn.apply(self, args),
      });
      return {
        channel,
        hasSubscribers: () => false,
        subscribe() {},
        unsubscribe: () => true,
        tracingChannel: (name: string) => ({
          start: channel(`tracing:${name}:start`),
          end: channel(`tracing:${name}:end`),
          asyncStart: channel(`tracing:${name}:asyncStart`),
          asyncEnd: channel(`tracing:${name}:asyncEnd`),
          error: channel(`tracing:${name}:error`),
          hasSubscribers: false,
          subscribe() {},
          unsubscribe() {},
          traceSync: (
            fn: (...a: unknown[]) => unknown,
            _ctx: unknown,
            self: unknown,
            ...args: unknown[]
          ) => fn.apply(self, args),
          tracePromise: (
            fn: (...a: unknown[]) => unknown,
            _ctx: unknown,
            self: unknown,
            ...args: unknown[]
          ) => fn.apply(self, args),
          traceCallback: (
            fn: (...a: unknown[]) => unknown,
            _pos: unknown,
            _ctx: unknown,
            self: unknown,
            ...args: unknown[]
          ) => fn.apply(self, args),
        }),
      };
    },
    dns: () => deps.net?.dns ?? createDns(null),
    'dns/promises': () => (deps.net?.dns ?? createDns(null)).promises,
    events: () => {
      const events = EventEmitter as unknown as Record<string, unknown>;
      events.EventEmitter ??= EventEmitter;
      events.once ??= once;
      events.on ??= on;
      events.setMaxListeners ??= () => {};
      events.getEventListeners ??= (emitter: EventEmitter, name: string) => emitter.listeners(name);
      events.addAbortListener ??= (signal: AbortSignal, fn: () => void) => {
        signal.addEventListener('abort', fn, { once: true });
        return { [Symbol.dispose]: () => signal.removeEventListener('abort', fn) };
      };
      return events;
    },
    fs: () => deps.fs,
    'fs/promises': () => deps.fsPromises,
    http: () =>
      web()?.http ??
      missing('http', ['createServer', 'request', 'get'], {
        STATUS_CODES,
        METHODS,
        Agent,
        globalAgent: {},
      }),
    // No HTTP/2 yet, but its constants, which clients read as they load
    // (undici's).
    http2: () =>
      missing('http2', ['createServer', 'createSecureServer', 'connect'], {
        constants: http2Constants(),
        sensitiveHeaders: Symbol('nodejs.http2.sensitiveHeaders'),
        getDefaultSettings: () => ({}),
      }),
    https: () =>
      web()?.https ??
      missing('https', ['createServer', 'request', 'get'], { Agent, globalAgent: new Agent() }),
    inspector: () => ({
      url: () => undefined,
      open() {},
      close() {},
      Session: class {
        connect() {}
        post() {}
        disconnect() {}
      },
    }),
    module: () => deps.module(),
    net: () =>
      deps.net?.module ??
      missing('net', ['createServer', 'createConnection', 'connect'], {
        isIP: (s: string) => (/^\d+\.\d+\.\d+\.\d+$/.test(s) ? 4 : s.includes(':') ? 6 : 0),
        isIPv4: (s: string) => /^\d+\.\d+\.\d+\.\d+$/.test(s),
        isIPv6: (s: string) => s.includes(':'),
        Socket: class Socket extends EventEmitter {},
      }),
    os: () => createOs(deps.env),
    path: () => deps.path,
    'path/posix': () => deps.path,
    'path/win32': () => deps.path,
    perf_hooks: () => ({
      // The browser's, with Node's markResourceTiming (undici's fetch reports
      // its timing there): nothing to mark.
      performance: Object.assign(performance, {
        markResourceTiming:
          (performance as { markResourceTiming?: unknown }).markResourceTiming ?? (() => undefined),
      }),
      PerformanceObserver: class {
        observe() {}
        disconnect() {}
      },
      monitorEventLoopDelay: () => ({
        enable() {},
        disable() {},
        percentile: () => 0,
        mean: 0,
        max: 0,
        min: 0,
      }),
      constants: {},
    }),
    process: () => process,
    punycode: () => ({ toASCII: (s: string) => s, toUnicode: (s: string) => s }),
    querystring: () => querystring,
    readline: () => createReadline().readline,
    'readline/promises': () => createReadline().promises,
    // Stream, with readable-stream's classes on it as Node's has them (and
    // its own promises, a getter).
    stream: () => {
      const out = stream.Stream as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(stream)) if (!(key in out)) out[key] = value;
      return out;
    },
    'stream/consumers': () => {
      const bytes = async (source: AsyncIterable<unknown>) => {
        const chunks: Buffer[] = [];
        for await (const chunk of source)
          chunks.push(
            typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array),
          );
        return Buffer.concat(chunks);
      };
      return {
        buffer: bytes,
        arrayBuffer: async (s: AsyncIterable<unknown>) => new Uint8Array(await bytes(s)).buffer,
        text: async (s: AsyncIterable<unknown>) => (await bytes(s)).toString('utf8'),
        json: async (s: AsyncIterable<unknown>) => JSON.parse((await bytes(s)).toString('utf8')),
        blob: async (s: AsyncIterable<unknown>) => new Blob([await bytes(s)]),
      };
    },
    'stream/promises': () => (stream as unknown as { promises: unknown }).promises,
    'stream/web': () => ({
      ReadableStream,
      WritableStream,
      TransformStream,
      TextEncoderStream,
      TextDecoderStream,
    }),
    string_decoder: () => ({ StringDecoder }),
    sys: () => util,
    timers: () => timers,
    'timers/promises': () => createTimersPromises(timers),
    tls: () =>
      deps.net
        ? createTls(deps.net, deps.runtime, deps.env)
        : missing('tls', ['connect', 'createServer', 'createSecureContext'], {
            rootCertificates: [],
          }),
    tty: () => ({
      isatty: (fd: number) => (fd === 0 ? deps.stdinTty : deps.tty && (fd === 1 || fd === 2)),
      ReadStream: class ReadStream extends EventEmitter {},
      WriteStream: class WriteStream extends EventEmitter {},
    }),
    url: () => createUrl((path) => (deps.path.resolve as (p: string) => string)(path)),
    util: () => util,
    'util/types': () => types,
    v8: () => ({
      getHeapStatistics: () => ({
        total_heap_size: 30e6,
        used_heap_size: 20e6,
        heap_size_limit: 2 ** 31,
        total_available_size: 2 ** 31,
      }),
      getHeapSpaceStatistics: () => [],
      setFlagsFromString() {},
      cachedDataVersionTag: () => 0,
      serialize: (value: unknown) => Buffer.from(JSON.stringify(value)),
      deserialize: (bytes: Uint8Array) => JSON.parse(Buffer.from(bytes).toString()),
    }),
    vm: () => createVm(),
    wasi: () => deps.wasi(),
    worker_threads: () => deps.threads(),
    zlib: () => createZlib(),
  };

  const made = new Map<string, unknown>();
  return (name: string): unknown => {
    if (!made.has(name)) {
      const factory = factories[name];
      if (!factory) throw new Error(`No such built-in module: node:${name}`);
      made.set(name, factory());
    }
    return made.get(name);
  };
}

// http2.constants as Node has them: HTTP2_HEADER_NAME (its pseudo-headers
// with a colon), HTTP2_METHOD_NAME, HTTP_STATUS_NAME, and nghttp2's error
// codes and settings.
function http2Constants(): Record<string, unknown> {
  const out: Record<string, unknown> = {
    NGHTTP2_NO_ERROR: 0,
    NGHTTP2_PROTOCOL_ERROR: 1,
    NGHTTP2_INTERNAL_ERROR: 2,
    NGHTTP2_FLOW_CONTROL_ERROR: 3,
    NGHTTP2_SETTINGS_TIMEOUT: 4,
    NGHTTP2_STREAM_CLOSED: 5,
    NGHTTP2_FRAME_SIZE_ERROR: 6,
    NGHTTP2_REFUSED_STREAM: 7,
    NGHTTP2_CANCEL: 8,
    NGHTTP2_COMPRESSION_ERROR: 9,
    NGHTTP2_CONNECT_ERROR: 10,
    NGHTTP2_ENHANCE_YOUR_CALM: 11,
    NGHTTP2_INADEQUATE_SECURITY: 12,
    NGHTTP2_HTTP_1_1_REQUIRED: 13,
    NGHTTP2_SESSION_CLIENT: 0,
    NGHTTP2_SESSION_SERVER: 1,
    NGHTTP2_DEFAULT_WEIGHT: 16,
    NGHTTP2_SETTINGS_HEADER_TABLE_SIZE: 1,
    NGHTTP2_SETTINGS_ENABLE_PUSH: 2,
    NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS: 3,
    NGHTTP2_SETTINGS_INITIAL_WINDOW_SIZE: 4,
    NGHTTP2_SETTINGS_MAX_FRAME_SIZE: 5,
    NGHTTP2_SETTINGS_MAX_HEADER_LIST_SIZE: 6,
    NGHTTP2_SETTINGS_ENABLE_CONNECT_PROTOCOL: 8,
    DEFAULT_SETTINGS_HEADER_TABLE_SIZE: 4096,
    DEFAULT_SETTINGS_ENABLE_PUSH: 1,
    DEFAULT_SETTINGS_INITIAL_WINDOW_SIZE: 65535,
    DEFAULT_SETTINGS_MAX_FRAME_SIZE: 16384,
    MAX_MAX_FRAME_SIZE: 16777215,
    MIN_MAX_FRAME_SIZE: 16384,
    MAX_INITIAL_WINDOW_SIZE: 2147483647,
    PADDING_STRATEGY_NONE: 0,
    PADDING_STRATEGY_ALIGNED: 1,
    PADDING_STRATEGY_MAX: 2,
    PADDING_STRATEGY_CALLBACK: 1,
  };
  for (const [code, text] of Object.entries(STATUS_CODES))
    out[
      `HTTP_STATUS_${String(text)
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_|_$/g, '')}`
    ] = Number(code);
  const pseudo = new Set(['AUTHORITY', 'METHOD', 'PATH', 'SCHEME', 'STATUS', 'PROTOCOL']);
  return new Proxy(out, {
    get(target, key) {
      if (typeof key !== 'string' || key in target) return target[key as string];
      if (key.startsWith('HTTP2_HEADER_')) {
        const name = key.slice(13);
        return pseudo.has(name) ? `:${name.toLowerCase()}` : name.toLowerCase().replace(/_/g, '-');
      }
      if (key.startsWith('HTTP2_METHOD_')) return key.slice(13).replace(/_/g, '-');
      return undefined;
    },
  });
}

// Node's AbortError, for what a signal cancelled.
function abortError(signal?: AbortSignal) {
  return Object.assign(new Error('The operation was aborted'), {
    name: 'AbortError',
    code: 'ABORT_ERR',
    cause: signal?.reason,
  });
}

// timers/promises on the process's timers: each takes a signal, which
// cancels it, and ref: false, which unrefs its timer.
function createTimersPromises(timers: Record<string, (...args: never[]) => unknown>) {
  type Options = { signal?: AbortSignal; ref?: boolean };
  type Timer = { unref?: () => void };
  const schedule = timers as unknown as {
    setTimeout(fn: () => void, ms?: number): Timer;
    setImmediate(fn: () => void): Timer;
    setInterval(fn: () => void, ms?: number): Timer;
    clearTimeout(timer: Timer): void;
    clearInterval(timer: Timer): void;
  };
  // `value` once `start`'s timer calls back.
  const later = <T>(start: (fn: () => void) => Timer, value: T, options: Options = {}) =>
    new Promise<T>((resolve, reject) => {
      const { signal, ref = true } = options;
      if (signal?.aborted) return reject(abortError(signal));
      const abort = () => {
        schedule.clearTimeout(timer);
        reject(abortError(signal));
      };
      const timer = start(() => {
        signal?.removeEventListener('abort', abort);
        resolve(value);
      });
      if (!ref) timer.unref?.();
      signal?.addEventListener('abort', abort, { once: true });
    });
  const setTimeout = <T>(ms?: number, value?: T, options?: Options) =>
    later((fn) => schedule.setTimeout(fn, ms), value, options);
  const setImmediate = <T>(value?: T, options?: Options) =>
    later((fn) => schedule.setImmediate(fn), value, options);
  // `value` each time the interval comes round, as many times as it has.
  async function* setInterval<T>(ms?: number, value?: T, options: Options = {}) {
    const { signal, ref = true } = options;
    if (signal?.aborted) throw abortError(signal);
    let pending = 0;
    let waiting: { resolve: () => void; reject: (error: unknown) => void } | undefined;
    const interval = schedule.setInterval(() => {
      pending++;
      waiting?.resolve();
      waiting = undefined;
    }, ms);
    if (!ref) interval.unref?.();
    const abort = () => {
      schedule.clearInterval(interval);
      waiting?.reject(abortError(signal));
      waiting = undefined;
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      for (;;) {
        if (signal?.aborted) throw abortError(signal);
        if (!pending) await new Promise<void>((resolve, reject) => (waiting = { resolve, reject }));
        for (; pending > 0; pending--) yield value;
      }
    } finally {
      schedule.clearInterval(interval);
      signal?.removeEventListener('abort', abort);
    }
  }
  return {
    setTimeout,
    setImmediate,
    setInterval,
    scheduler: {
      wait: (ms: number, options?: Options) => setTimeout(ms, undefined, options),
      yield: () => setImmediate(),
    },
  };
}

// events.on: an async iterator of an event's arguments, until it is
// returned from, an 'error' (which it throws, after the events before it)
// or its signal's abort.
function on(emitter: EventEmitter, event: string, options: { signal?: AbortSignal } = {}) {
  const { signal } = options;
  const aborted = () => abortError(signal);
  if (signal?.aborted) throw aborted();
  const queue: unknown[][] = [];
  const waiting: {
    resolve: (value: IteratorResult<unknown[]>) => void;
    reject: (error: unknown) => void;
  }[] = [];
  let error: unknown = null;
  let finished = false;
  const listener = (...args: unknown[]) => {
    const next = waiting.shift();
    if (next) next.resolve({ value: args, done: false });
    else queue.push(args);
  };
  const close = () => {
    finished = true;
    emitter.off(event, listener);
    if (event !== 'error') emitter.off('error', fail);
    signal?.removeEventListener('abort', abort);
    for (const next of waiting.splice(0)) next.resolve({ value: undefined, done: true });
  };
  const fail = (e: unknown) => {
    const next = waiting.shift();
    if (next) next.reject(e);
    else error = e;
    close();
  };
  const abort = () => fail(aborted());
  emitter.on(event, listener);
  if (event !== 'error') emitter.on('error', fail);
  signal?.addEventListener('abort', abort, { once: true });
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: (): Promise<IteratorResult<unknown[]>> => {
      if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
      if (error) {
        const rejected = Promise.reject(error);
        error = null;
        return rejected;
      }
      if (finished) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    return: () => {
      close();
      return Promise.resolve({ value: undefined, done: true });
    },
  };
}

// querystring as Node has it: a repeated key's values an array, and what
// decodeURIComponent cannot decode taken as bytes (%XX), the rest as is.
const querystring = (() => {
  const unescapeBuffer = (text: string, decodeSpaces = false) => {
    const bytes = Buffer.from(decodeSpaces ? text.replace(/\+/g, ' ') : text);
    const out: number[] = [];
    for (let i = 0; i < bytes.length; i++) {
      const hex = bytes[i] === 0x25 ? String.fromCharCode(bytes[i + 1], bytes[i + 2]) : '';
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
      } else out.push(bytes[i]);
    }
    return Buffer.from(out);
  };
  const unescape = (text: string, decodeSpaces = false) => {
    try {
      return decodeURIComponent(text);
    } catch {
      return new TextDecoder().decode(unescapeBuffer(text, decodeSpaces));
    }
  };
  const escape = (text: unknown) => encodeURIComponent(String(text));
  // A value as stringify writes it: primitives only, other values empty.
  const primitive = (value: unknown) =>
    typeof value === 'string'
      ? value
      : (typeof value === 'number' && Number.isFinite(value)) ||
          typeof value === 'bigint' ||
          typeof value === 'boolean'
        ? String(value)
        : '';
  const stringify = (
    object: unknown,
    sep?: string | null,
    eq?: string | null,
    options?: { encodeURIComponent?: (text: string) => string },
  ) => {
    if (object === null || typeof object !== 'object') return '';
    const encode = options?.encodeURIComponent ?? escape;
    const fields: string[] = [];
    for (const [key, value] of Object.entries(object)) {
      const prefix = encode(primitive(key)) + (eq || '=');
      for (const item of Array.isArray(value) ? value : [value])
        fields.push(prefix + encode(primitive(item)));
    }
    return fields.join(sep || '&');
  };
  const parse = (
    text: unknown,
    sep?: string | null,
    eq?: string | null,
    options?: { maxKeys?: number; decodeURIComponent?: (text: string) => string },
  ) => {
    const out: Record<string, string | string[]> = Object.create(null);
    if (typeof text !== 'string' || !text) return out;
    const decoder = options?.decodeURIComponent ?? unescape;
    const decode = (piece: string) => {
      if (!/[%+]/.test(piece)) return piece;
      const spaced = piece.replace(/\+/g, '%20');
      try {
        return decoder(spaced);
      } catch {
        return unescape(spaced, true);
      }
    };
    const maxKeys = typeof options?.maxKeys === 'number' ? options.maxKeys : 1000;
    const equals = eq || '=';
    let pairs = text.split(sep || '&');
    if (maxKeys > 0) pairs = pairs.slice(0, maxKeys);
    for (const pair of pairs) {
      if (!pair) continue;
      const at = pair.indexOf(equals);
      const key = decode(at < 0 ? pair : pair.slice(0, at));
      const value = decode(at < 0 ? '' : pair.slice(at + equals.length));
      const previous = out[key];
      if (previous === undefined) out[key] = value;
      else if (Array.isArray(previous)) previous.push(value);
      else out[key] = [previous, value];
    }
    return out;
  };
  return { unescapeBuffer, unescape, escape, stringify, encode: stringify, parse, decode: parse };
})();

const osConstants = {
  signals,
  errno: { ENOENT: 2, EACCES: 13, EEXIST: 17, ENOTDIR: 20, EISDIR: 21, EINVAL: 22, ENOTEMPTY: 39 },
  priority: { PRIORITY_LOW: 19, PRIORITY_NORMAL: 0, PRIORITY_HIGH: -14 },
};

function createOs(env: Record<string, string>) {
  const count = navigator.hardwareConcurrency || 4;
  const cpu = {
    model: 'WebAssembly playground',
    speed: 2400,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
  };
  return {
    EOL: '\n',
    devNull: '/dev/null',
    constants: osConstants,
    arch: () => 'x64',
    platform: () => 'linux',
    type: () => 'Linux',
    machine: () => 'x86_64',
    release: () => '6.12.0-playground',
    version: () => '#1 SMP',
    hostname: () => 'playground',
    homedir: () => env.HOME ?? '/home/user',
    tmpdir: () => env.TMPDIR ?? '/tmp',
    endianness: () => 'LE',
    cpus: () => Array.from({ length: count }, () => ({ ...cpu })),
    availableParallelism: () => count,
    totalmem: () => 4 * 2 ** 30,
    freemem: () => 2 * 2 ** 30,
    loadavg: () => [0, 0, 0],
    uptime: () => Math.floor(performance.now() / 1000),
    networkInterfaces: () => ({}),
    userInfo: () => ({
      username: env.USER ?? 'user',
      uid: 1000,
      gid: 1000,
      shell: '/bin/sh',
      homedir: env.HOME ?? '/home/user',
    }),
    getPriority: () => 0,
    setPriority: () => {},
  };
}

// The protocols whose URLs url.format writes with slashes.
const slashed = new Set(['http:', 'https:', 'ftp:', 'gopher:', 'file:', 'ws:', 'wss:']);

// resolve(path): an absolute path, as path.resolve makes it.
function createUrl(resolve: (path: string) => string) {
  const fileURLToPath = (url: string | URL) => {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    if (parsed.protocol !== 'file:') {
      const error = new TypeError('The URL must be of scheme file') as TypeError & { code: string };
      error.code = 'ERR_INVALID_URL_SCHEME';
      throw error;
    }
    return decodeURIComponent(parsed.pathname);
  };
  // As Node makes it: the path resolved (a trailing slash kept), with %,
  // \\, newlines, tabs, # and ? escaped; the URL parser escapes the rest.
  const pathToFileURL = (path: string) => {
    let absolute = resolve(path);
    if (path.endsWith('/') && !absolute.endsWith('/')) absolute += '/';
    const escaped = absolute
      .replace(/%/g, '%25')
      .replace(/\\/g, '%5C')
      .replace(/\n/g, '%0A')
      .replace(/\r/g, '%0D')
      .replace(/\t/g, '%09')
      .replace(/#/g, '%23')
      .replace(/\?/g, '%3F');
    return new URL(`file://${escaped}`);
  };
  const parse = (text: string, query = false) => {
    try {
      const url = new URL(text);
      return {
        protocol: url.protocol,
        slashes: true,
        auth: url.username ? `${url.username}${url.password ? `:${url.password}` : ''}` : null,
        host: url.host,
        port: url.port || null,
        hostname: url.hostname,
        hash: url.hash || null,
        search: url.search || null,
        query: query ? Object.fromEntries(url.searchParams) : url.search.slice(1) || null,
        pathname: url.pathname,
        path: url.pathname + url.search,
        href: url.href,
      };
    } catch {
      const [pathname, search = ''] = text.split('?');
      return {
        protocol: null,
        slashes: null,
        host: null,
        hostname: null,
        pathname,
        search: search ? `?${search}` : null,
        query: query ? Object.fromEntries(new URLSearchParams(search)) : search || null,
        path: text,
        href: text,
      };
    }
  };
  // A URL with or without its auth, search and fragment; a string as the
  // URL parser has it; a url object (url.parse's) as Node's legacy format
  // writes it.
  const format = (
    url: unknown,
    options: { auth?: boolean; search?: boolean; fragment?: boolean } = {},
  ) => {
    if (url instanceof URL) {
      const { auth = true, search = true, fragment = true } = options;
      const slashes = url.href.startsWith(`${url.protocol}//`);
      const user =
        auth && url.username ? `${url.username}${url.password ? `:${url.password}` : ''}@` : '';
      return `${url.protocol}${slashes ? '//' : ''}${user}${url.host}${url.pathname}${search ? url.search : ''}${fragment ? url.hash : ''}`;
    }
    if (typeof url === 'string') {
      try {
        return new URL(url).href;
      } catch {
        return url;
      }
    }
    const object = (url ?? {}) as Record<string, unknown>;
    const string = (key: string) => (object[key] ? String(object[key]) : '');
    const auth = object.auth ? `${encodeURIComponent(string('auth')).replace(/%3A/g, ':')}@` : '';
    let protocol = string('protocol');
    if (protocol && !protocol.endsWith(':')) protocol += ':';
    let host = '';
    if (object.host) host = auth + string('host');
    else if (object.hostname) {
      const hostname = string('hostname');
      host =
        auth + (hostname.includes(':') && !/^\[.*\]$/.test(hostname) ? `[${hostname}]` : hostname);
      if (object.port) host += `:${string('port')}`;
    }
    const query =
      object.query && typeof object.query === 'object' ? querystring.stringify(object.query) : '';
    let search = string('search') || (query && `?${query}`);
    let pathname = string('pathname').replace(/#/g, '%23').replace(/\?/g, '%3F');
    if (object.slashes || slashed.has(protocol)) {
      if (object.slashes || host) {
        if (pathname && !pathname.startsWith('/')) pathname = `/${pathname}`;
        host = `//${host}`;
      } else if (protocol === 'file:') host = '//';
    }
    search = search.replace(/#/g, '%23');
    if (search && !search.startsWith('?')) search = `?${search}`;
    let hash = string('hash');
    if (hash && !hash.startsWith('#')) hash = `#${hash}`;
    return protocol + host + pathname + search + hash;
  };
  return {
    URL,
    URLSearchParams,
    fileURLToPath,
    pathToFileURL,
    parse,
    format,
    resolve: (from: string, to: string) =>
      new URL(to, new URL(from, 'resolve://')).href.replace(/^resolve:\/\//, ''),
    domainToASCII: (domain: string) => domain,
    domainToUnicode: (domain: string) => domain,
    urlToHttpOptions: (url: URL) => ({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
    }),
  };
}

function createVm() {
  const runIn = (code: string, context: Record<string, unknown> = {}) => {
    const names = Object.keys(context);
    // oxlint-disable-next-line no-new-func -- vm runs code.
    return new Function(...names, `return eval(${JSON.stringify(code)})`)(
      ...names.map((n) => context[n]),
    );
  };
  class Script {
    constructor(private code: string) {}
    // oxlint-disable-next-line no-eval -- vm runs code.
    runInThisContext = () => (0, eval)(this.code);
    runInNewContext = (context?: Record<string, unknown>) => runIn(this.code, context);
    runInContext = (context?: Record<string, unknown>) => runIn(this.code, context);
    createCachedData = () => new Uint8Array(0);
  }
  return {
    Script,
    // oxlint-disable-next-line no-eval -- vm runs code.
    runInThisContext: (code: string) => (0, eval)(code),
    runInNewContext: runIn,
    runInContext: runIn,
    createContext: (context: object = {}) => context,
    isContext: () => true,
    compileFunction: (code: string, params: string[] = []) => new Function(...params, code),
  };
}

function createCrypto() {
  // getRandomValues', 65536 bytes at a time (its most).
  const fill = (bytes: Uint8Array) => {
    for (let at = 0; at < bytes.length; at += 65536)
      crypto.getRandomValues(bytes.subarray(at, at + 65536) as Uint8Array<ArrayBuffer>);
  };
  const randomBytes = (size: number, callback?: (e: unknown, b: Buffer) => void) => {
    const bytes = Buffer.alloc(size);
    fill(bytes);
    if (callback) queueMicrotask(() => callback(null, bytes));
    return bytes;
  };
  // offset and size in the view's elements, as Node has them.
  const randomFillSync = <T extends ArrayBufferView | ArrayBuffer>(
    buffer: T,
    offset = 0,
    size?: number,
  ) => {
    const view = ArrayBuffer.isView(buffer) ? buffer : new Uint8Array(buffer);
    const element = (view as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1;
    const length = view.byteLength / element;
    fill(
      new Uint8Array(
        view.buffer,
        view.byteOffset + offset * element,
        (size ?? length - offset) * element,
      ),
    );
    return buffer;
  };
  return {
    webcrypto: crypto,
    subtle: crypto.subtle,
    getRandomValues: (array: ArrayBufferView) =>
      crypto.getRandomValues(array as Uint8Array<ArrayBuffer>),
    randomUUID: () => crypto.randomUUID(),
    randomBytes,
    pseudoRandomBytes: randomBytes,
    randomFillSync,
    // randomFillSync's, its callback's afterwards: (buffer, [offset], [size], done).
    randomFill: (buffer: ArrayBufferView | ArrayBuffer, ...args: unknown[]) => {
      const done = args.pop() as (e: unknown, b: unknown) => void;
      if (typeof done !== 'function')
        throw Object.assign(new TypeError('The "callback" argument must be of type function'), {
          code: 'ERR_INVALID_ARG_TYPE',
        });
      randomFillSync(buffer, ...(args as [number?, number?]));
      queueMicrotask(() => done(null, buffer));
    },
    randomInt: (min: number, max?: number) => {
      if (max === undefined) [min, max] = [0, min];
      return min + Math.floor(Math.random() * (max - min));
    },
    timingSafeEqual: (a: Uint8Array, b: Uint8Array) =>
      a.length === b.length && a.every((x, i) => x === b[i]),
    ...hashes,
    ...missing('crypto', [
      'createCipheriv',
      'createDecipheriv',
      'pbkdf2Sync',
      'scryptSync',
      'createSign',
      'createVerify',
      'generateKeyPairSync',
    ]),
  };
}

// http's and https's Agent: its options kept, as nothing connects yet.
class Agent {
  constructor(public options: Record<string, unknown> = {}) {}
}

// Node's, made from its options; without a message, one of the values.
class AssertionError extends Error {
  code = 'ERR_ASSERTION';
  actual: unknown;
  expected: unknown;
  operator?: string;
  generatedMessage: boolean;
  constructor(options: {
    message?: string;
    actual?: unknown;
    expected?: unknown;
    operator?: string;
  }) {
    const { message, actual, expected, operator } = options;
    super(message ?? `${inspect(actual)} ${operator} ${inspect(expected)}`);
    this.name = 'AssertionError';
    this.actual = actual;
    this.expected = expected;
    this.operator = operator;
    this.generatedMessage = message === undefined;
  }
}

function createAssert() {
  const fail = (
    message: unknown,
    fallback: string,
    actual?: unknown,
    expected?: unknown,
    operator?: string,
  ): never => {
    if (message instanceof Error) throw message;
    const error = new AssertionError({
      message: (message as string) ?? fallback,
      actual,
      expected,
      operator,
    });
    error.generatedMessage = message === undefined;
    throw error;
  };
  // assert.deepEqual's: == for primitives; for objects, a Date's time, a
  // RegExp's source and flags, an Error's name and message, a Map's and a
  // Set's entries (by ==, deeply), and their own keys.
  const looseEqual = (a: unknown, b: unknown): boolean => {
    // oxlint-disable-next-line eqeqeq -- assert.equal is ==.
    if (a == b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    for (const kind of [Date, RegExp, Error, Map, Set])
      if (a instanceof kind !== b instanceof kind) return false;
    if (a instanceof Date && a.getTime() !== (b as Date).getTime()) return false;
    if (a instanceof RegExp && String(a) !== String(b)) return false;
    if (a instanceof Error && (a.name !== (b as Error).name || a.message !== (b as Error).message))
      return false;
    if (a instanceof Map) {
      const other = b as Map<unknown, unknown>;
      if (a.size !== other.size) return false;
      for (const [key, value] of a)
        if (
          other.has(key)
            ? !looseEqual(value, other.get(key))
            : ![...other].some(([k, v]) => looseEqual(key, k) && looseEqual(value, v))
        )
          return false;
    }
    if (a instanceof Set) {
      const other = b as Set<unknown>;
      if (a.size !== other.size) return false;
      for (const item of a)
        if (!other.has(item) && ![...other].some((x) => looseEqual(item, x))) return false;
    }
    const ka = Object.keys(a);
    return (
      ka.length === Object.keys(b).length &&
      ka.every((k) =>
        looseEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
      )
    );
  };
  const matches = (error: unknown, expected: unknown): boolean => {
    if (expected === undefined) return true;
    if (typeof expected === 'function') {
      if (
        (expected as { prototype?: unknown }).prototype !== undefined &&
        error instanceof (expected as new () => unknown)
      )
        return true;
      if (Error.isPrototypeOf(expected as object)) return false;
      return (expected as (e: unknown) => boolean)(error) === true;
    }
    if (expected instanceof RegExp) return expected.test(String(error));
    if (typeof expected === 'object' && expected)
      return Object.entries(expected).every(([k, v]) => {
        const actual = (error as Record<string, unknown>)[k];
        return v instanceof RegExp ? v.test(String(actual)) : isDeepStrictEqual(actual, v);
      });
    return false;
  };
  // throws' and rejects' failure: what was missing, of which class, and
  // the message if there is one.
  const missed = (kind: string, operator: string, expected: unknown, message: unknown) => {
    const name = typeof expected === 'function' ? (expected as { name: string }).name : '';
    const text = `Missing expected ${kind}${name ? ` (${name})` : ''}`;
    if (message === undefined) fail(undefined, `${text}.`, undefined, expected, operator);
    fail(
      message instanceof Error ? message : `${text}: ${message}`,
      '',
      undefined,
      expected,
      operator,
    );
  };
  const ok = (value: unknown, message?: unknown) => {
    if (!value)
      fail(
        message,
        `The expression evaluated to a falsy value:\n\n  assert.ok(${inspect(value)})\n`,
        value,
        true,
        '==',
      );
  };
  const assert = Object.assign(ok, {
    ok,
    AssertionError,
    fail: (message?: unknown) => fail(message, 'Failed'),
    equal: (a: unknown, b: unknown, message?: unknown) => {
      // oxlint-disable-next-line eqeqeq -- assert.equal is ==.
      if (a != b) fail(message, `${inspect(a)} == ${inspect(b)}`, a, b, '==');
    },
    notEqual: (a: unknown, b: unknown, message?: unknown) => {
      // oxlint-disable-next-line eqeqeq -- assert.notEqual is !=.
      if (a == b) fail(message, `${inspect(a)} != ${inspect(b)}`, a, b, '!=');
    },
    strictEqual: (a: unknown, b: unknown, message?: unknown) => {
      if (!Object.is(a, b))
        fail(
          message,
          `Expected values to be strictly equal:\n\n${inspect(a)} !== ${inspect(b)}\n`,
          a,
          b,
          'strictEqual',
        );
    },
    notStrictEqual: (a: unknown, b: unknown, message?: unknown) => {
      if (Object.is(a, b))
        fail(
          message,
          `Expected "actual" to be strictly unequal to: ${inspect(b)}`,
          a,
          b,
          'notStrictEqual',
        );
    },
    deepEqual: (a: unknown, b: unknown, message?: unknown) => {
      if (!looseEqual(a, b))
        fail(
          message,
          `Expected values to be loosely deep-equal:\n\n${inspect(a)}\n\nshould loosely deep-equal\n\n${inspect(b)}`,
          a,
          b,
          'deepEqual',
        );
    },
    notDeepEqual: (a: unknown, b: unknown, message?: unknown) => {
      if (looseEqual(a, b))
        fail(
          message,
          `Expected values not to be loosely deep-equal:\n\n${inspect(a)}\n\nshould not loosely deep-equal\n\n${inspect(b)}`,
          a,
          b,
          'notDeepEqual',
        );
    },
    deepStrictEqual: (a: unknown, b: unknown, message?: unknown) => {
      if (!isDeepStrictEqual(a, b))
        fail(
          message,
          `Expected values to be strictly deep-equal:\n\n${inspect(a)}\n\nshould equal\n\n${inspect(b)}`,
          a,
          b,
          'deepStrictEqual',
        );
    },
    notDeepStrictEqual: (a: unknown, b: unknown, message?: unknown) => {
      if (isDeepStrictEqual(a, b))
        fail(
          message,
          'Expected "actual" not to be strictly deep-equal to "expected"',
          a,
          b,
          'notDeepStrictEqual',
        );
    },
    match: (text: string, pattern: RegExp, message?: unknown) => {
      if (!pattern.test(text))
        fail(
          message,
          `The input did not match the regular expression ${pattern}. Input:\n\n${inspect(text)}\n`,
          text,
          pattern,
          'match',
        );
    },
    doesNotMatch: (text: string, pattern: RegExp, message?: unknown) => {
      if (pattern.test(text))
        fail(
          message,
          `The input was expected to not match the regular expression ${pattern}.`,
          text,
          pattern,
          'doesNotMatch',
        );
    },
    throws: (fn: () => unknown, expected?: unknown, message?: unknown) => {
      if (typeof expected === 'string') [expected, message] = [undefined, expected];
      try {
        fn();
      } catch (error) {
        if (!matches(error, expected)) throw error;
        return;
      }
      missed('exception', 'throws', expected, message);
    },
    doesNotThrow: (fn: () => unknown) => {
      fn();
    },
    rejects: async (
      promise: Promise<unknown> | (() => Promise<unknown>),
      expected?: unknown,
      message?: unknown,
    ) => {
      if (typeof expected === 'string') [expected, message] = [undefined, expected];
      try {
        await (typeof promise === 'function' ? promise() : promise);
      } catch (error) {
        if (!matches(error, expected)) throw error;
        return;
      }
      missed('rejection', 'rejects', expected, message);
    },
    doesNotReject: async (promise: Promise<unknown> | (() => Promise<unknown>)) => {
      await (typeof promise === 'function' ? promise() : promise);
    },
    ifError: (value: unknown) => {
      if (value !== null && value !== undefined) throw value;
    },
    strict: null as unknown,
  });
  assert.strict = Object.assign((v: unknown, m?: unknown) => ok(v, m), assert, {
    equal: assert.strictEqual,
    notEqual: assert.notStrictEqual,
    deepEqual: assert.deepStrictEqual,
    notDeepEqual: assert.notDeepStrictEqual,
  });
  return assert;
}
