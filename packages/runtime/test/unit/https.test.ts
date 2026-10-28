import { afterEach, describe, expect, test, vi } from 'vitest';
import { httpsByFetch } from '../../src/https';

// The gateway's answer to `request`, when the site's fetch() answers
// `response`: what it wrote after its first line.
async function gateway(request: string, response: Response | (() => Promise<Response>)) {
  vi.stubGlobal('fetch', response instanceof Response ? async () => response : response);
  let written = '';
  const connection = {
    write: (bytes: Uint8Array) => (written += new TextDecoder().decode(bytes)),
    end: () => {},
  } as unknown as Parameters<ReturnType<typeof httpsByFetch>>[0];
  httpsByFetch()(connection, { host: 'example.com', port: 443 });
  connection.ondata(new TextEncoder().encode(request));
  await new Promise((resolve) => setTimeout(resolve, 10));
  return written.slice('fetch\n'.length);
}

afterEach(() => vi.unstubAllGlobals());

describe("the gateway's answer", () => {
  test('to a HEAD keeps the length the site gave', async () => {
    const answer = await gateway(
      'HEAD /file HTTP/1.1\r\nHost: example.com\r\n\r\n',
      new Response(null, { headers: { 'content-length': '1234' } }),
    );
    expect(answer).toMatch(/^content-length: 1234\r$/m);
    expect(answer).not.toMatch(/^content-length: 0\r$/m);
  });

  test('without a body says its length is 0', async () => {
    const answer = await gateway(
      'GET / HTTP/1.1\r\nHost: example.com\r\n\r\n',
      new Response(null, { status: 205 }),
    );
    expect(answer).toMatch(/^content-length: 0\r$/m);
  });

  test("without the site's reason gives the status's own", async () => {
    const answer = await gateway(
      'GET /missing HTTP/1.1\r\nHost: example.com\r\n\r\n',
      new Response('no', { status: 404 }),
    );
    expect(answer).toMatch(/^HTTP\/1\.1 404 Not Found\r\n/);
  });

  test.each(['abc', '-5', '1.5'])(
    'to a Content-Length of %s is 400, fetched not',
    async (length) => {
      const fetched = vi.fn(async () => new Response(null));
      const answer = await gateway(
        `POST /form HTTP/1.1\r\nHost: example.com\r\nContent-Length: ${length}\r\n\r\nbody`,
        fetched,
      );
      expect(answer).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
      expect(fetched).not.toHaveBeenCalled();
    },
  );

  test.each(['-5', 'zz'])('to a chunk size of %s is 400, fetched not', async (size) => {
    const fetched = vi.fn(async () => new Response(null));
    const answer = await gateway(
      'POST /form HTTP/1.1\r\nHost: example.com\r\nTransfer-Encoding: chunked\r\n\r\n' +
        `${size}\r\nbody\r\n0\r\n\r\n`,
      fetched,
    );
    expect(answer).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
    expect(fetched).not.toHaveBeenCalled();
  });
});
