import { EventEmitter } from 'node:events';
import { Duplex, type Readable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { createHttp } from '@/runtime/nodejs/http';

// A connection the test answers on: what it is sent is dropped.
function connection() {
  return new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

// A GET whose response is `answer`, then the connection's end; what the
// response said: its body, whether it was complete, and its error. (net's
// Server: the base of http's, which a request does not use.)
function get(answer: string) {
  const { http } = createHttp({ Server: EventEmitter } as never);
  const socket = connection();
  return new Promise<{ body: string; complete: boolean; aborted: boolean; error?: string }>(
    (resolve, reject) => {
      const req = http.request(
        { createConnection: () => socket as never },
        (res: EventEmitter & { complete: boolean }) => {
          let body = '';
          let aborted = false;
          res.on('data', (chunk: Buffer) => (body += chunk.toString()));
          res.on('aborted', () => (aborted = true));
          res.on('end', () => resolve({ body, complete: res.complete, aborted }));
          res.on('error', (error: Error & { code?: string }) =>
            resolve({
              body,
              complete: res.complete,
              aborted,
              error: `${error.message} ${error.code}`,
            }),
          );
        },
      );
      req.on('error', reject);
      req.end();
      socket.push(answer);
      socket.push(null);
    },
  );
}

// A GET answered with `answer` (the connection kept open), its response
// destroyed once it has come: whether the connection was destroyed too.
function destroyed(answer: string) {
  const { http } = createHttp({ Server: EventEmitter } as never);
  const socket = connection();
  return new Promise<boolean>((resolve) => {
    const req = http.request(
      { createConnection: () => socket as never },
      (res: Readable & { complete: boolean }) => {
        res.on('error', () => {});
        res.resume();
        setTimeout(() => {
          res.destroy();
          setTimeout(() => resolve(socket.destroyed));
        });
      },
    );
    req.on('error', () => {});
    req.end();
    socket.push(answer);
  });
}

describe('a response destroyed', () => {
  test('before it is complete destroys its connection', async () => {
    expect(await destroyed('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc')).toBe(true);
  });

  test('once complete leaves its connection', async () => {
    expect(await destroyed('HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc')).toBe(false);
  });
});

describe('a response as the connection ends', () => {
  test('with all of its length is complete', async () => {
    expect(await get('HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc')).toEqual({
      body: 'abc',
      complete: true,
      aborted: false,
    });
  });

  test('without all of its length is aborted', async () => {
    const res = await get('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc');
    expect(res).toMatchObject({ complete: false, aborted: true, error: 'aborted ECONNRESET' });
  });

  test('without its last chunk is aborted', async () => {
    const res = await get('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n');
    expect(res).toMatchObject({ complete: false, aborted: true, error: 'aborted ECONNRESET' });
  });

  test('with its last chunk is complete', async () => {
    const res = await get(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n',
    );
    expect(res).toEqual({ body: 'abc', complete: true, aborted: false });
  });

  test('with neither length nor chunks is complete at the end', async () => {
    expect(await get('HTTP/1.1 200 OK\r\n\r\nabc')).toEqual({
      body: 'abc',
      complete: true,
      aborted: false,
    });
  });
});

// A connection to a server, which keeps what it is sent (and its end, as
// <end>).
function served() {
  const sent: Buffer[] = [];
  const socket = new Duplex({
    allowHalfOpen: true,
    read() {},
    write(chunk, _encoding, callback) {
      sent.push(Buffer.from(chunk));
      callback();
    },
    final(callback) {
      sent.push(Buffer.from('<end>'));
      callback();
    },
  });
  return { socket, sent: () => Buffer.concat(sent).toString() };
}

const later = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a server', () => {
  test('answers the requests that came before the client ended its side', async () => {
    const { http } = createHttp({ Server: EventEmitter } as never);
    const server = new http.Server((req, res) => setTimeout(() => res.end(`hi ${req.url}`), 5));
    const { socket, sent } = served();
    server.emit('connection', socket);
    socket.push('GET /a HTTP/1.1\r\nHost: x\r\n\r\nGET /b HTTP/1.1\r\nHost: x\r\n\r\n');
    socket.push(null);
    await later(40);
    expect(sent()).toContain('hi /a');
    expect(sent()).toContain('hi /b');
    expect(sent()).toMatch(/<end>$/);
  });

  test('closes a request and its response still answered when the client goes', async () => {
    const { http } = createHttp({ Server: EventEmitter } as never);
    const heard: string[] = [];
    let answer: { write(text: string): void; end(): void; destroyed: boolean } | undefined;
    const server = new http.Server((req, res) => {
      req.on('close', () => heard.push('req close'));
      res.on('close', () => heard.push('res close'));
      res.write('data: x\n\n');
      answer = res;
    });
    const { socket } = served();
    server.emit('connection', socket);
    socket.push('GET /events HTTP/1.1\r\nHost: x\r\n\r\n');
    await later();
    socket.destroy();
    await later();
    expect(heard).toEqual(['req close', 'res close']);
    expect(answer!.destroyed).toBe(true);
    // Written after, it goes nowhere.
    answer!.write('data: y\n\n');
    answer!.end();
    await later();
  });
});

test("an upgrade's connection is its owner's: its error is not the response's", async () => {
  const { http } = createHttp({ Server: EventEmitter } as never);
  const socket = connection();
  const req = http.request({ createConnection: () => socket as never });
  const [res, upgraded] = await new Promise<[EventEmitter, Duplex]>((resolve) => {
    req.on('upgrade', (...args: [EventEmitter, Duplex]) => resolve(args));
    req.end();
    socket.push(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
  });
  const errors: string[] = [];
  res.on('error', (error: Error) => errors.push(`res ${error.message}`));
  req.on('error', (error: Error) => errors.push(`req ${error.message}`));
  upgraded.on('error', (error: Error) => errors.push(`socket ${error.message}`));
  upgraded.destroy(new Error('reset'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(errors).toEqual(['socket reset']);
});

test('a response with neither length nor chunks is aborted when its request is destroyed', async () => {
  const { http } = createHttp({ Server: EventEmitter } as never);
  const socket = connection();
  const res = await new Promise<Readable & { complete: boolean; aborted: boolean; req: Readable }>(
    (resolve) => {
      const req = http.request({ createConnection: () => socket as never }, resolve);
      req.on('error', () => {});
      req.end();
      socket.push('HTTP/1.1 200 OK\r\n\r\nabc');
    },
  );
  const outcome = new Promise<string>((resolve) => {
    res.on('end', () => resolve('end'));
    res.on('error', (error: Error) => resolve(error.message));
    res.resume();
  });
  res.req.destroy();
  expect(await outcome).toBe('aborted');
  expect(res).toMatchObject({ complete: false, aborted: true });
});
