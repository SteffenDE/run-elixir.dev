// The browser's web streams with what Node's carry for node:stream's
// finished() (end-of-stream): a promise settled when the stream closes,
// under Symbol.for('nodejs.webstream.isClosedPromise'). readable-stream
// reads it for a web stream, and undici calls finished() on a response's
// body: without it, that threw, and undici's fetch aborted the request.
//
// It settles as the stream's consumer sees it end, never by locking the
// stream itself: the reader's or writer's own closed promise (getReader,
// getWriter), pipeTo's, or cancel/abort.

const CLOSED = Symbol.for('nodejs.webstream.isClosedPromise');

type Deferred = { promise: Promise<void>; resolve(): void; reject(reason: unknown): void };

const deferreds = new WeakMap<object, Deferred>();

function deferred(stream: object): Deferred {
  let found = deferreds.get(stream);
  if (!found) {
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Not settling is no unhandled rejection; finished() listens.
    promise.catch(() => {});
    found = { promise, resolve, reject };
    deferreds.set(stream, found);
  }
  return found;
}

function patch(
  proto: object | undefined,
  name: string,
  after: (stream: object, result: unknown) => void,
) {
  const target = proto as Record<string, unknown> | undefined;
  const original = target?.[name];
  if (typeof original !== 'function') return;
  target![name] = function (this: object, ...args: unknown[]) {
    const result = (original as (...a: unknown[]) => unknown).apply(this, args);
    after(this, result);
    return result;
  };
}

const settle = (stream: object, closed: unknown) => {
  if (closed instanceof Promise)
    closed.then(
      () => deferred(stream).resolve(),
      (reason) => deferred(stream).reject(reason),
    );
};

export function installClosedPromises(): void {
  for (const Stream of [globalThis.ReadableStream, globalThis.WritableStream]) {
    const proto = Stream?.prototype;
    if (!proto || CLOSED in proto) continue;
    Object.defineProperty(proto, CLOSED, {
      configurable: true,
      get(this: object) {
        return deferred(this);
      },
    });
  }
  patch(globalThis.ReadableStream?.prototype, 'getReader', (stream, reader) =>
    settle(stream, (reader as { closed?: unknown }).closed),
  );
  patch(globalThis.WritableStream?.prototype, 'getWriter', (stream, writer) =>
    settle(stream, (writer as { closed?: unknown }).closed),
  );
  patch(globalThis.ReadableStream?.prototype, 'pipeTo', settle);
  patch(globalThis.ReadableStream?.prototype, 'cancel', settle);
  patch(globalThis.WritableStream?.prototype, 'abort', settle);
  patch(globalThis.WritableStream?.prototype, 'close', settle);
}
