// The current shell ABI captures an external command's output before
// running the next pipeline stage. Bound that capture so an infinite
// producer fails instead of exhausting the browser's memory.
export class OutputLimitError extends Error {
  constructor() {
    super('shell: buffered output exceeded 16 MiB; streaming pipes are not supported');
  }
}

export class BufferedOutput {
  private streams: Record<number, Uint8Array[]> = { 1: [], 2: [] };
  private size = 0;

  constructor(private limit = 16 << 20) {}

  write(stream: number, bytes: Uint8Array): void {
    if (this.size + bytes.length > this.limit) throw new OutputLimitError();
    this.size += bytes.length;
    this.streams[stream].push(bytes.slice());
  }

  read(stream: number, into: Uint8Array): number {
    const chunks = this.streams[stream] ?? [];
    let at = 0;
    while (chunks.length && at < into.length) {
      const chunk = chunks[0];
      const take = Math.min(chunk.length, into.length - at);
      into.set(chunk.subarray(0, take), at);
      at += take;
      this.size -= take;
      if (take === chunk.length) chunks.shift();
      else chunks[0] = chunk.subarray(take);
    }
    return at;
  }
}
