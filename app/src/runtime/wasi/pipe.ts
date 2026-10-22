// A pipe between processes (processes.ts), or between a process and its
// host: what is written waits until it is read, up to CAPACITY bytes. A
// read of an empty pipe whose writers are all gone is its end; a write to
// one whose readers are all gone fails (EPIPE). A process that would wait
// (empty to read, full to write) is told when the pipe changes
// (`changed`), and tries again: under JSPI it is suspended meanwhile
// (WASI's `suspending`). A writer that cannot wait (the host, or a
// program run to its end on its caller's thread) writes past CAPACITY.
export const CAPACITY = 64 * 1024;

export class Pipe {
  declare chunks: Uint8Array[];
  declare size: number;
  // The ends still open: descriptors that read it, and that write it.
  declare readers: number;
  declare writers: number;
  declare waiting: (() => void)[];

  constructor() {
    this.chunks = [];
    this.size = 0;
    this.readers = 0;
    this.writers = 0;
    this.waiting = [];
  }

  // Up to `max` bytes; an empty array at its end; null while it is empty
  // and may still be written.
  read(max: number): Uint8Array | null {
    if (!this.size) return this.writers ? null : new Uint8Array(0);
    const out = new Uint8Array(Math.min(max, this.size));
    let at = 0;
    while (at < out.length) {
      const chunk = this.chunks[0];
      const part = chunk.subarray(0, out.length - at);
      out.set(part, at);
      at += part.length;
      if (part.length === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(part.length);
    }
    this.size -= out.length;
    this.wake();
    return out;
  }

  // How many of `bytes` it took: -1 with no reader left, null while it is
  // full (unless the writer cannot wait: `bounded` false takes them all).
  write(bytes: Uint8Array, bounded = true): number | null {
    if (!this.readers) return -1;
    if (!bytes.length) return 0;
    const room = bounded ? CAPACITY - this.size : bytes.length;
    if (room <= 0) return null;
    const part = bytes.slice(0, room);
    this.chunks.push(part);
    this.size += part.length;
    this.wake();
    return part.length;
  }

  // Once something is written, read, or an end closed.
  changed(): Promise<void> {
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  open(reads: boolean): void {
    if (reads) this.readers++;
    else this.writers++;
  }

  close(reads: boolean): void {
    if (reads) this.readers--;
    else this.writers--;
    this.wake();
  }

  wake(): void {
    const waiting = this.waiting.splice(0);
    for (const resolve of waiting) resolve();
  }
}
