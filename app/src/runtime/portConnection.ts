// A connection carried over a MessagePort: a node's, from the worker that
// runs the project (docs/frames.md), to a service the IDE's page answers
// on the apex (Postgres, Hex's cache), or back. Each side's stream is a
// Connection's shape (host/node.ts): ondata, onend, onclose; write, end,
// close. Bytes go as transferred buffers.
export interface Stream {
  ondata: (bytes: Uint8Array) => void;
  onend: () => void;
  onclose: () => void;
  write(bytes: Uint8Array): void;
  end(): void;
  close(): void;
}

type Frame = { data: Uint8Array } | { end: true } | { close: true };

// Send `stream`'s traffic over `port`, and the other side's back into it.
export function carry(stream: Stream, port: MessagePort): void {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    port.close();
  };
  stream.ondata = (bytes) => {
    const copy = bytes.slice();
    port.postMessage({ data: copy } satisfies Frame, [copy.buffer]);
  };
  stream.onend = () => port.postMessage({ end: true } satisfies Frame);
  stream.onclose = () => {
    if (!closed) port.postMessage({ close: true } satisfies Frame);
    close();
  };
  port.onmessage = ({ data }: MessageEvent<Frame>) => {
    if ('data' in data) stream.write(data.data);
    else if ('end' in data) stream.end();
    else {
      close();
      stream.close();
    }
  };
}

// The other side of carry(): a connection a service takes as a node's
// (`node`, its node's stand-in: postgres.ts tells nodes apart by it).
export class PortConnection implements Stream {
  ondata: (bytes: Uint8Array) => void = () => {};
  onend: () => void = () => {};
  onclose: () => void = () => {};
  private closed = false;

  constructor(
    private readonly port: MessagePort,
    readonly node: object,
    readonly id: number,
  ) {
    port.onmessage = ({ data }: MessageEvent<Frame>) => {
      if ('data' in data) this.ondata(data.data);
      else if ('end' in data) this.onend();
      else this.gone();
    };
  }

  write(bytes: Uint8Array): void {
    if (this.closed) return;
    const copy = bytes.slice();
    this.port.postMessage({ data: copy } satisfies Frame, [copy.buffer]);
  }

  end(): void {
    if (!this.closed) this.port.postMessage({ end: true } satisfies Frame);
  }

  close(): void {
    if (this.closed) return;
    this.port.postMessage({ close: true } satisfies Frame);
    this.gone();
  }

  private gone(): void {
    if (this.closed) return;
    this.closed = true;
    this.port.close();
    this.onclose();
  }
}
