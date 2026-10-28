// The internet for the node, over plain HTTP on a port the page serves
// (host/node.ts serve): a request the node makes there is answered with the
// page's fetch() of the URL route(path) names (a promise; null: 404). The
// node has no sockets of its own, and the page can only read what CORS
// lets it; Hex
// is pointed here (HEX_MIRROR, HEX_API_URL), and the route sends its
// repository through a proxy where repo.hex.pm sends no CORS headers.
//
// Each connection carries one request (GET or HEAD; no body) and is
// closed after its answer. Successful answers for which keep(url) holds
// (what never changes, such as a package's tarball) are kept in the
// Cache Storage `cache`, by URL.
import type { Served } from './host/node';

const HEAD_END = [13, 10, 13, 10];

function indexOf(bytes: Uint8Array, pattern: number[]): number {
  outer: for (let i = 0; i + pattern.length <= bytes.length; i++) {
    for (let j = 0; j < pattern.length; j++) if (bytes[i + j] !== pattern[j]) continue outer;
    return i;
  }
  return -1;
}

function respond(
  connection: Served,
  status: number,
  reason: string,
  headers: [string, string][],
  body: Uint8Array,
): void {
  const lines = [
    `HTTP/1.1 ${status} ${reason}`,
    `content-length: ${body.length}`,
    'connection: close',
  ];
  for (const [name, value] of headers) lines.push(`${name}: ${value}`);
  connection.write(new TextEncoder().encode(lines.join('\r\n') + '\r\n\r\n'));
  if (body.length) connection.write(body);
  connection.end();
}

// cache: a Cache Storage name, or null.
export function fetcher({
  route,
  keep = () => false,
  cache = 'playground-fetch',
  onrequest = () => {},
}: {
  route(path: string): Promise<string | null> | string | null;
  keep?: (url: string) => boolean;
  cache?: string | null;
  onrequest?: (method: string, path: string, url: string | null) => void;
}): (connection: Served) => void {
  async function get(url: string, method: string): Promise<Response> {
    const store = cache && keep(url) && (await caches.open(cache).catch(() => null));
    const kept = store && (await store.match(url));
    if (kept) return kept;
    const response = await fetch(url, { method, credentials: 'omit' });
    if (store && method === 'GET' && response.ok)
      await store.put(url, response.clone()).catch(() => {});
    return response;
  }

  return (connection) => {
    let buffer = new Uint8Array(0);
    let answered = false;
    connection.ondata = async (bytes) => {
      if (answered) return;
      const joined = new Uint8Array(buffer.length + bytes.length);
      joined.set(buffer);
      joined.set(bytes, buffer.length);
      buffer = joined;
      if (indexOf(buffer, HEAD_END) < 0) return;
      answered = true;
      const [method, target] = new TextDecoder().decode(buffer).split('\r\n')[0].split(' ');
      const path = target.replace(/^https?:\/\/[^/]+/, '');
      const url = ['GET', 'HEAD'].includes(method) ? await route(path) : null;
      onrequest(method, path, url);
      if (!url) {
        respond(
          connection,
          404,
          'Not Found',
          [['content-type', 'text/plain']],
          new TextEncoder().encode(`${path}: not here\n`),
        );
        return;
      }
      try {
        const response = await get(url, method);
        const body =
          method === 'HEAD' ? new Uint8Array(0) : new Uint8Array(await response.arrayBuffer());
        const headers: [string, string][] = [];
        for (const name of ['content-type', 'etag', 'last-modified', 'cache-control']) {
          const value = response.headers.get(name);
          if (value) headers.push([name, value]);
        }
        respond(connection, response.status, response.statusText || 'OK', headers, body);
      } catch (error) {
        respond(
          connection,
          502,
          'Bad Gateway',
          [['content-type', 'text/plain']],
          new TextEncoder().encode(`${url}: ${(error as Error).message}\n`),
        );
      }
    };
  };
}
