import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createFetch } from '../../src/nodejs/fetch';
import { createHttp } from '../../src/nodejs/http';

// Node's fetch over http.ts, on connections the test answers: `answer`
// hears each request's head as it was sent (and the connection to answer
// it on).
function fetcher(answer: (socket: Duplex, sent: string) => void) {
  const { http } = createHttp({ Server: EventEmitter } as never);
  const client = {
    request(url: URL, options: Record<string, unknown>, callback: never) {
      let sent = '';
      const socket: Duplex = new Duplex({
        read() {},
        write(chunk, _encoding, done) {
          const had = sent.includes('\r\n\r\n');
          sent += chunk;
          if (!had && sent.includes('\r\n\r\n')) answer(socket, sent);
          done();
        },
      });
      return http.request(url, { ...options, createConnection: () => socket }, callback);
    },
  };
  return createFetch(client as never, client as never, fetch, () => () => {});
}

const OK = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok';

afterEach(() => vi.unstubAllGlobals());

describe('a request', () => {
  // The browser's Request, which leaves out the headers it sets itself.
  const browserRequest = class extends Request {
    get headers() {
      const headers = new Headers(super.headers);
      for (const name of ['accept-encoding', 'cookie', 'origin', 'referer', 'host'])
        headers.delete(name);
      return headers;
    }
  };

  test('sends the headers the browser would leave out', async () => {
    vi.stubGlobal('Request', browserRequest);
    let sent = '';
    const fetch = fetcher((socket, head) => {
      sent = head;
      socket.push(OK);
    });
    await fetch('http://localhost:1/', {
      headers: { 'Accept-Encoding': 'identity', Cookie: 'a=1', Origin: 'http://x' },
    });
    expect(sent).toMatch(/^accept-encoding: identity$/m);
    expect(sent).toMatch(/^cookie: a=1$/m);
    expect(sent).toMatch(/^origin: http:\/\/x$/m);
  });

  test('keeps the content type its body gives it', async () => {
    let sent = '';
    const fetch = fetcher((socket, head) => {
      sent = head;
      socket.push(OK);
    });
    await fetch('http://localhost:1/', { method: 'POST', body: new URLSearchParams({ a: '1' }) });
    expect(sent).toMatch(/^content-type: application\/x-www-form-urlencoded/m);
  });
});

describe('an abort', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
  // What a body read ends with: its text, or its error's name.
  const outcome = (read: Promise<string>) =>
    read.then(
      (text) => `text ${text}`,
      (error: Error) => error.name,
    );

  test('before the request rejects with the signal’s reason', async () => {
    const fetch = fetcher((socket) => socket.push(OK));
    const signal = AbortSignal.abort();
    await expect(fetch('http://localhost:1/', { signal })).rejects.toBe(signal.reason);
  });

  test('before the answer rejects with the signal’s reason', async () => {
    const controller = new AbortController();
    const fetch = fetcher(() => controller.abort());
    await expect(fetch('http://localhost:1/', { signal: controller.signal })).rejects.toBe(
      controller.signal.reason,
    );
  });

  for (const [framing, answer] of [
    ['in chunks', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n'],
    ['until the connection ends', 'HTTP/1.1 200 OK\r\n\r\nok'],
  ])
    test(`in a body ${framing} errors it with the signal’s reason`, async () => {
      const controller = new AbortController();
      const fetch = fetcher((socket) => socket.push(answer));
      const res = await fetch('http://localhost:1/', { signal: controller.signal });
      const read = outcome(res.text());
      await tick();
      controller.abort();
      expect(await read).toBe('AbortError');
    });

  test('is heard no more once the body is read', async () => {
    const controller = new AbortController();
    let heard = 0;
    const { signal } = controller;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...args: Parameters<typeof add>) => {
      heard++;
      add(...args);
    }) as typeof add;
    signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      heard--;
      remove(...args);
    }) as typeof remove;
    const fetch = fetcher((socket, head) =>
      socket.push(
        head.startsWith('GET /a')
          ? 'HTTP/1.1 302 Found\r\nLocation: /b\r\nContent-Length: 0\r\n\r\n'
          : OK,
      ),
    );
    const res = await fetch('http://localhost:1/a', { signal });
    expect(await res.text()).toBe('ok');
    expect(heard).toBe(0);
  });
});

describe('a redirect', () => {
  test('by 303 keeps a HEAD a HEAD', async () => {
    const lines: string[] = [];
    const fetch = fetcher((socket, head) => {
      lines.push(head.split('\r\n')[0]);
      socket.push(
        lines.length === 1
          ? 'HTTP/1.1 303 See Other\r\nLocation: /b\r\nContent-Length: 0\r\n\r\n'
          : 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n',
      );
    });
    const res = await fetch('http://localhost:1/a', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(lines).toEqual(['HEAD /a HTTP/1.1', 'HEAD /b HTTP/1.1']);
  });
});
