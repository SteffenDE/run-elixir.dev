import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { createBuiltins } from '../../src/nodejs/builtins';

// events as the browser bundle has it: the events package, not Node's.
vi.mock('node:events', async () => {
  // @ts-expect-error -- the events package has no types of its own.
  const { default: events } = (await import('events/events.js')) as {
    default: typeof EventEmitter & { once: unknown };
  };
  return { default: events, EventEmitter: events, once: events.once };
});

// The builtin table on fakes: a process whose stderr goes nowhere, and
// the host's timers.
function builtins(options: { tty?: boolean; stdinTty?: boolean } = {}) {
  const process = Object.assign(new EventEmitter(), { stderr: { write() {} } });
  return createBuiltins({
    fs: {},
    fsPromises: {},
    path: { resolve: (p: string) => p },
    process: process as never,
    console: {},
    timers: { setTimeout, setImmediate, setInterval, clearTimeout, clearInterval } as never,
    module: () => ({}),
    env: {},
    tty: options.tty ?? false,
    stdinTty: options.stdinTty ?? false,
    wasi: () => ({}),
    threads: () => ({}),
    net: null,
    tls: null,
    child: null,
  });
}

describe('querystring', () => {
  type Qs = Record<string, (...args: unknown[]) => unknown>;
  const qs = () => builtins()('querystring') as Qs;

  test('parse gathers a repeated key into an array, on a null prototype', () => {
    const parsed = qs().parse('a=1&a=2&a=3&&b&=x&c=1=2&d+e=f+g%20h') as object;
    expect(Object.getPrototypeOf(parsed)).toBe(null);
    expect({ ...parsed }).toEqual({ a: ['1', '2', '3'], b: '', '': 'x', c: '1=2', 'd e': 'f g h' });
  });

  test('parse takes sep, eq, maxKeys and decodeURIComponent', () => {
    expect({ ...(qs().parse('a:1;b:2;c:3', ';', ':', { maxKeys: 2 }) as object) }).toEqual({
      a: '1',
      b: '2',
    });
    const decode = (s: string) => `[${s}]`;
    expect({
      ...(qs().parse('a+b=%41&c=d', null, null, { decodeURIComponent: decode }) as object),
    }).toEqual({ '[a%20b]': '[%41]', c: 'd' });
  });

  test('parse decodes what decodeURIComponent cannot as bytes', () => {
    expect({ ...(qs().parse('a=%E0%A4%A&b=%zz') as object) }).toEqual({ a: '�%A', b: '%zz' });
  });

  test('stringify repeats an array, and writes primitives only', () => {
    expect(
      qs().stringify({ q: 'a b', l: ['x', 'y'], e: [], n: 1, i: Infinity, b: true, o: {}, s: '' }),
    ).toBe('q=a%20b&l=x&l=y&n=1&i=&b=true&o=&s=');
    expect(
      qs().stringify({ a: 'x y' }, ';', ':', {
        encodeURIComponent: (s: string) => s.toUpperCase(),
      }),
    ).toBe('A:X Y');
    expect(qs().stringify('x')).toBe('');
  });

  test('has the aliases and the escapes', () => {
    const q = qs();
    expect(q.decode).toBe(q.parse);
    expect(q.encode).toBe(q.stringify);
    expect(q.escape('ä b')).toBe('%C3%A4%20b');
    expect(q.unescape('%zz%41+')).toBe('%zzA+');
    expect([...(q.unescapeBuffer('a+%41', true) as Uint8Array)]).toEqual([0x61, 0x20, 0x41]);
  });
});

test("tty.isatty answers stdin's for 0, stdout's and stderr's for 1 and 2", () => {
  const isatty = (options: { tty: boolean; stdinTty: boolean }) =>
    [0, 1, 2, 3].map((builtins(options)('tty') as { isatty(fd: number): boolean }).isatty);
  expect(isatty({ tty: true, stdinTty: false })).toEqual([false, true, true, false]);
  expect(isatty({ tty: false, stdinTty: true })).toEqual([true, false, false, false]);
});

describe('url.format', () => {
  const format = (...args: unknown[]) =>
    (builtins()('url') as { format(...args: unknown[]): string }).format(...args);

  test("writes a url object's port, query, auth and hash, as Node does", () => {
    expect(
      format({
        protocol: 'http',
        hostname: 'a.com',
        port: 8080,
        pathname: 'x#?y',
        query: { a: '1 2', b: ['x', 'y'] },
      }),
    ).toBe('http://a.com:8080/x%23%3Fy?a=1%202&b=x&b=y');
    expect(
      format({
        protocol: 'https:',
        host: 'h:1',
        hostname: 'ignored',
        port: 2,
        auth: 'a b:c@d',
        search: 'q=1#',
        query: { z: 1 },
        hash: 'frag',
      }),
    ).toBe('https://a%20b:c%40d@h:1?q=1%23#frag');
    expect(format({ protocol: 'http', hostname: '::1', port: 3 })).toBe('http://[::1]:3');
  });

  test('gives slashes to the protocols that have them, or when asked', () => {
    expect(format({ protocol: 'mailto', pathname: 'a@b.c' })).toBe('mailto:a@b.c');
    expect(format({ protocol: 'mailto', slashes: true, host: 'x', pathname: 'p' })).toBe(
      'mailto://x/p',
    );
    expect(format({ protocol: 'file', pathname: '/etc' })).toBe('file:///etc');
    expect(format({ protocol: 'http', pathname: '/etc' })).toBe('http:/etc');
    expect(format({ host: 'a.com', pathname: 'p' })).toBe('a.comp');
    expect(format({ slashes: true, host: 'a.com', pathname: 'p' })).toBe('//a.com/p');
    expect(format({})).toBe('');
  });

  test("a string's and a URL's, with the URL's options", () => {
    expect(format('http://u:p@a.com/x?y=1#z')).toBe('http://u:p@a.com/x?y=1#z');
    const url = new URL('http://u:p@a.com:81/p?q#h');
    expect(format(url)).toBe(url.href);
    expect(format(url, { auth: false, search: false, fragment: false })).toBe('http://a.com:81/p');
    expect(format(new URL('mailto:x@y'), {})).toBe('mailto:x@y');
  });
});

describe('assert', () => {
  type Assert = Record<string, (...args: unknown[]) => unknown> & {
    AssertionError: new (options: object) => Error & Record<string, unknown>;
  };
  const assert = () => builtins()('assert') as Assert;

  test('throws takes a string as its message', async () => {
    const a = assert();
    a.throws(() => {
      throw new Error('x');
    }, 'message');
    expect(() => a.throws(() => {}, 'message')).toThrow('Missing expected exception: message');
    expect(() => a.throws(() => {}, TypeError, 'message')).toThrow(
      'Missing expected exception (TypeError): message',
    );
    await a.rejects(Promise.reject(new Error('x')), 'message');
    await expect(a.rejects(Promise.resolve(), 'message')).rejects.toThrow(
      'Missing expected rejection: message',
    );
  });

  test('deepEqual compares Dates, Maps, Sets, RegExps and Errors, loosely', () => {
    const a = assert();
    a.deepEqual(new Date(1), new Date(1));
    a.deepEqual(new Set([1]), new Set(['1']));
    a.deepEqual(new Map([[1, { a: 1 }]]), new Map([[1, { a: '1' }]]));
    a.deepEqual([1], ['1']);
    for (const [x, y] of [
      [new Date(1), new Date(2)],
      [new Map([[1, 2]]), new Map([[1, 3]])],
      [new Set([1]), new Set([2])],
      [/a/g, /a/i],
      [new Error('a'), new Error('b')],
      [[1], { 0: 1 }],
    ])
      expect(() => a.deepEqual(x, y)).toThrow(a.AssertionError);
  });

  test('has notDeepEqual', () => {
    const a = assert();
    a.notDeepEqual({ a: 1 }, { a: 2 });
    expect(() => a.notDeepEqual({ a: 1 }, { a: '1' })).toThrow(
      expect.objectContaining({ operator: 'notDeepEqual' }),
    );
  });

  test('AssertionError takes its options', () => {
    const { AssertionError } = assert();
    const error = new AssertionError({ message: 'm', actual: 1, expected: 2, operator: 'op' });
    expect({ ...error, message: error.message }).toMatchObject({
      message: 'm',
      actual: 1,
      expected: 2,
      operator: 'op',
      code: 'ERR_ASSERTION',
      generatedMessage: false,
    });
    expect(new AssertionError({ actual: 1, expected: 2, operator: 'op' }).message).toBe('1 op 2');
  });
});

describe('events.on', () => {
  type Events = {
    on(
      emitter: EventEmitter,
      event: string,
      options?: { signal?: AbortSignal },
    ): AsyncIterableIterator<unknown[]>;
  };
  const on = (...args: Parameters<Events['on']>) => (builtins()('events') as Events).on(...args);

  test('leaving the loop removes its listeners', async () => {
    const emitter = new EventEmitter();
    queueMicrotask(() => emitter.emit('tick', 1));
    for await (const [value] of on(emitter, 'tick')) {
      expect(value).toBe(1);
      break;
    }
    expect([emitter.listenerCount('tick'), emitter.listenerCount('error')]).toEqual([0, 0]);
  });

  test("an 'error' rejects it, after what came before", async () => {
    const emitter = new EventEmitter();
    const iterator = on(emitter, 'tick');
    emitter.emit('tick', 1);
    emitter.emit('error', new Error('boom'));
    expect(await iterator.next()).toEqual({ value: [1], done: false });
    await expect(iterator.next()).rejects.toThrow('boom');
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(emitter.listenerCount('tick')).toBe(0);
  });

  test('its signal aborts it', async () => {
    const emitter = new EventEmitter();
    const controller = new AbortController();
    const iterator = on(emitter, 'tick', { signal: controller.signal });
    const next = iterator.next();
    controller.abort();
    await expect(next).rejects.toMatchObject({ name: 'AbortError' });
    expect(emitter.listenerCount('tick')).toBe(0);
  });
});

describe('timers/promises', () => {
  type Options = { signal?: AbortSignal; ref?: boolean };
  type Timers = {
    setTimeout(ms: number, value?: unknown, options?: Options): Promise<unknown>;
    setImmediate(value?: unknown, options?: Options): Promise<unknown>;
    setInterval(ms: number, value?: unknown, options?: Options): AsyncIterableIterator<unknown>;
  };
  const timers = () => builtins()('timers/promises') as Timers;

  test('setTimeout and setImmediate heed their signal', async () => {
    const t = timers();
    expect(await t.setTimeout(1, 'v')).toBe('v');
    await expect(t.setTimeout(1, 'v', { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'AbortError',
      code: 'ABORT_ERR',
    });
    const controller = new AbortController();
    const waiting = t.setTimeout(10_000, 'v', { signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await expect(t.setImmediate('v', { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  test('ref: false unrefs the timer', async () => {
    let unrefs = 0;
    const timer = { unref: () => unrefs++ };
    const fake = (fn: () => void) => {
      queueMicrotask(fn);
      return timer;
    };
    const process = Object.assign(new EventEmitter(), { stderr: { write() {} } });
    const t = createBuiltins({
      ...({} as Parameters<typeof createBuiltins>[0]),
      process: process as never,
      timers: { setTimeout: fake, setImmediate: fake, clearTimeout() {} } as never,
    })('timers/promises') as Timers;
    await t.setTimeout(1, 'v', { ref: false });
    await t.setTimeout(1, 'v');
    expect(unrefs).toBe(1);
  });

  test('setInterval yields its value each time, until left or aborted', async () => {
    const t = timers();
    let count = 0;
    for await (const value of t.setInterval(1, 'tick')) {
      expect(value).toBe('tick');
      if (++count === 3) break;
    }
    expect(count).toBe(3);
    const controller = new AbortController();
    const iterator = t.setInterval(1, 'tick', { signal: controller.signal });
    expect(await iterator.next()).toEqual({ value: 'tick', done: false });
    const next = iterator.next();
    controller.abort();
    await expect(next).rejects.toMatchObject({ name: 'AbortError' });
  });
});

test('crypto.randomFillSync fills from offset for size, past 65536 bytes', () => {
  const { randomFillSync } = builtins()('crypto') as {
    randomFillSync(buffer: ArrayBufferView, offset?: number, size?: number): ArrayBufferView;
  };
  const big = new Uint8Array(200_000);
  expect(randomFillSync(big)).toBe(big);
  expect(big.subarray(150_000).some((b) => b !== 0)).toBe(true);
  const small = new Uint8Array(64);
  randomFillSync(small, 16, 32);
  expect([...small.subarray(0, 16), ...small.subarray(48)].every((b) => b === 0)).toBe(true);
  expect(small.subarray(16, 48).some((b) => b !== 0)).toBe(true);
  const words = new Uint32Array(8);
  randomFillSync(words, 4);
  expect([...words.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
  expect(words.subarray(4).some((w) => w !== 0)).toBe(true);
});

test('crypto.randomFill fills as randomFillSync, then calls back', async () => {
  const { randomFill } = builtins()('crypto') as {
    randomFill(buffer: ArrayBufferView, ...args: unknown[]): void;
  };
  const small = new Uint8Array(64);
  const filled = await new Promise((resolve) =>
    randomFill(small, 16, 32, (_: unknown, b: unknown) => resolve(b)),
  );
  expect(filled).toBe(small);
  expect([...small.subarray(0, 16), ...small.subarray(48)].every((b) => b === 0)).toBe(true);
  expect(small.subarray(16, 48).some((b) => b !== 0)).toBe(true);
  expect(() => randomFill(small)).toThrow(TypeError);
});

describe('stream/promises', () => {
  type Streams = Record<string, new (options: object) => NodeJS.ReadWriteStream>;
  const pipeline = () =>
    (builtins()('stream/promises') as { pipeline(...args: unknown[]): Promise<void> }).pipeline;

  test('pipeline takes a trailing options object as options, not a stream', async () => {
    const { Readable, Writable } = builtins()('stream') as Streams;
    const written: string[] = [];
    const source = new Readable({
      read(this: { push(chunk: unknown): void }) {
        this.push('a');
        this.push(null);
      },
    });
    const sink = new Writable({
      write(chunk: Buffer, _encoding: string, callback: () => void) {
        written.push(chunk.toString());
        callback();
      },
    });
    await pipeline()(source, sink, { signal: new AbortController().signal });
    expect(written).toEqual(['a']);
  });

  test("pipeline's signal aborts it", async () => {
    const { Readable, PassThrough } = builtins()('stream') as Streams;
    const source = new Readable({ read() {} });
    await expect(
      pipeline()(source, new PassThrough({}), { signal: AbortSignal.abort() }),
    ).rejects.toThrow(/abort/i);
  });
});
