// Node's global fetch, as undici's: requests by the process's own http and
// https (http.ts), not the browser's fetch, so a request goes where Node's
// would: the project's ports (http://localhost:PORT, another process's
// server, a node's), and other hosts through the tailnet with the process's
// own TLS (tls.ts), else by the exec frame's fetch() (https.ts's gateway,
// CORS's rules). Redirects followed (or not, as `redirect` says), gzip and
// deflate answers decompressed; data: and blob: URLs are the browser's.

type Http = {
  request(url: URL, options: Record<string, unknown>, callback: (res: Incoming) => void): Outgoing;
};
type Incoming = {
  statusCode: number;
  statusMessage: string | null;
  rawHeaders: string[];
  headers: Record<string, string | string[] | undefined>;
  on(event: string, listener: (...args: never[]) => void): Incoming;
  destroy(error?: Error): void;
  pause(): void;
  resume(): void;
};
type Outgoing = {
  on(event: 'error', listener: (error: Error) => void): Outgoing;
  write(chunk: Uint8Array): boolean;
  end(): void;
  destroy(error?: Error): void;
};

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY = new Set([101, 204, 205, 304]);

const failed = (cause: unknown) => Object.assign(new TypeError('fetch failed'), { cause });

// hold(): the process's loop held, until the release it answers (a fetch
// holds it from its call to its body's end, as Node's does: reading the
// request's body may take a task, before any socket holds it).
export function createFetch(
  http: Http,
  https: Http,
  browserFetch: typeof fetch,
  hold: () => () => void,
): typeof fetch {
  const one = (
    url: URL,
    method: string,
    headers: Headers,
    body: Uint8Array | null,
    signal: AbortSignal | null,
  ) =>
    new Promise<Incoming>((resolve, reject) => {
      const flat: string[] = [];
      headers.forEach((value, name) => flat.push(name, value));
      const client = url.protocol === 'https:' ? https : http;
      const req = client.request(url, { method, headers: flat }, resolve);
      req.on('error', (error) => reject(failed(error)));
      const abort = () => req.destroy(signal!.reason ?? new DOMException('aborted', 'AbortError'));
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      signal?.addEventListener('abort', abort, { once: true });
      if (body?.length) req.write(body);
      req.end();
    });

  const nodeFetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const release = hold();
    try {
      return await fetched(input, init, release);
    } catch (error) {
      release();
      throw error;
    }
  };

  const fetched = async (
    input: RequestInfo | URL,
    init: RequestInit,
    release: () => void,
  ): Promise<Response> => {
    const request = new Request(input, init);
    let url = new URL(request.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return browserFetch(input, init).finally(release);
    let method = request.method;
    const headers = new Headers(request.headers);
    if (!headers.has('accept')) headers.set('accept', '*/*');
    if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'gzip, deflate');
    if (!headers.has('user-agent')) headers.set('user-agent', 'node');
    // Its bytes, read whole (Firefox's Request has no body stream to ask).
    let body: Uint8Array | null =
      method === 'GET' || method === 'HEAD' ? null : new Uint8Array(await request.arrayBuffer());
    if (body && !body.length) body = null;
    const signal = init.signal ?? null;
    const redirect = init.redirect ?? 'follow';
    for (let hops = 0; ; hops++) {
      const res = await one(url, method, headers, body, signal);
      const location = res.headers.location;
      if (REDIRECTS.has(res.statusCode) && typeof location === 'string' && redirect !== 'manual') {
        res.resume();
        if (redirect === 'error') throw failed(new Error('unexpected redirect'));
        if (hops >= 20) throw failed(new Error('redirect count exceeded'));
        const next = new URL(location, url);
        // 303, and 301/302 for a POST, go on as a GET without its body.
        if (
          res.statusCode === 303 ||
          ((res.statusCode === 301 || res.statusCode === 302) && method === 'POST')
        ) {
          method = 'GET';
          body = null;
          headers.delete('content-type');
          headers.delete('content-length');
        }
        if (next.origin !== url.origin) headers.delete('authorization');
        url = next;
        continue;
      }
      const answered = new Headers();
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2)
        answered.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
      // The body as it comes, decompressed as Node's fetch does.
      let stream: ReadableStream<Uint8Array> | null = null;
      if (method !== 'HEAD' && !NULL_BODY.has(res.statusCode)) {
        stream = new ReadableStream<Uint8Array>({
          start(controller) {
            res.on('data', (chunk: Uint8Array) => controller.enqueue(new Uint8Array(chunk)));
            res.on('end', () => {
              release();
              controller.close();
            });
            res.on('error', (error: Error) => {
              release();
              controller.error(failed(error));
            });
          },
          cancel() {
            release();
            res.destroy();
          },
        });
        const coding = (answered.get('content-encoding') ?? '').trim().toLowerCase();
        if (coding === 'gzip' || coding === 'x-gzip' || coding === 'deflate')
          stream = stream.pipeThrough(
            new DecompressionStream(
              coding === 'deflate' ? 'deflate' : 'gzip',
            ) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
          );
      } else {
        res.resume();
        release();
      }
      const response = new Response(stream, {
        status: res.statusCode,
        statusText: res.statusMessage ?? '',
        headers: answered,
      });
      // url and redirected, as a fetched response has them.
      Object.defineProperty(response, 'url', { value: url.href });
      Object.defineProperty(response, 'redirected', { value: hops > 0 });
      return response;
    }
  };
  return nodeFetch as typeof fetch;
}
