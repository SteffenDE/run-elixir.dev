// Calls and events over a MessagePort, between the IDE's page and the
// worker that runs its project (docs/frames.md): either side may call the
// other's handlers by name, and send events it has no answer for. What a
// call or an event carries goes as a structured clone; `transfer` hands
// over buffers and ports.
type Handler = (...args: never[]) => unknown;
type Listener = (data: never) => void;

type Message =
  | { call: number; method: string; args: unknown[] }
  | { reply: number; value?: unknown; error?: string }
  | { event: string; data: unknown };

// A value to send with what it hands over (a result's buffers, say).
export class Transfer<T> {
  constructor(
    readonly value: T,
    readonly transfer: Transferable[],
  ) {}
}
export const transfer = <T>(value: T, list: Transferable[]) => new Transfer(value, list);

export class Rpc {
  private next = 1;
  private waiting = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private handlers: Record<string, Handler> = {};
  private listeners = new Map<string, Set<Listener>>();

  constructor(readonly port: MessagePort) {
    port.onmessage = ({ data }: MessageEvent<Message>) => void this.receive(data);
  }

  // What this side answers.
  handle(handlers: Record<string, Handler>): this {
    Object.assign(this.handlers, handlers);
    return this;
  }

  call<T>(method: string, args: unknown[] = [], list: Transferable[] = []): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.port.postMessage({ call: id, method, args } satisfies Message, list);
    });
  }

  emit(event: string, data?: unknown, list: Transferable[] = []): void {
    this.port.postMessage({ event, data } satisfies Message, list);
  }

  on<T>(event: string, listener: (data: T) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener as Listener);
    return () => set.delete(listener as Listener);
  }

  close(): void {
    for (const { reject } of this.waiting.values()) reject(new Error('closed'));
    this.waiting.clear();
    this.port.close();
  }

  private async receive(message: Message): Promise<void> {
    if ('reply' in message) {
      const waiting = this.waiting.get(message.reply);
      this.waiting.delete(message.reply);
      if (message.error !== undefined) waiting?.reject(new Error(message.error));
      else waiting?.resolve(message.value);
    } else if ('call' in message) {
      try {
        const handler = this.handlers[message.method];
        if (!handler) throw new Error(`no such call: ${message.method}`);
        const result = await (handler as (...args: unknown[]) => unknown)(...message.args);
        const [value, list] =
          result instanceof Transfer ? [result.value, result.transfer] : [result, []];
        this.port.postMessage({ reply: message.call, value } satisfies Message, list);
      } catch (error) {
        this.port.postMessage({
          reply: message.call,
          error: error instanceof Error ? error.message : String(error),
        } satisfies Message);
      }
    } else {
      for (const listener of this.listeners.get(message.event) ?? [])
        (listener as (data: unknown) => void)(message.data);
    }
  }
}
