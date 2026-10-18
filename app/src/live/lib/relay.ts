// The backend's relay (backend/: PlaygroundWeb.LiveChannel), as
// a participant sees it: a Phoenix channel `live:ID` on the site's
// /socket, carrying opaque bytes to everyone admitted or to one
// participant, and the session's news. Nothing here knows the keys.
import { Socket, type Channel } from 'phoenix';

export type Role = 'host' | 'guest';

export interface Participant {
  id: string;
  admitted: boolean;
}

// What a join answers.
export interface Joined {
  id: string;
  host: string;
  host_present: boolean;
  admitted: boolean;
  participants: Participant[];
  token: string | null;
}

export interface RelayEvents {
  // Joined (again, after a lost connection: a guest then has a new id).
  joined(joined: Joined): void;
  // Could not join: no_session, taken, full, bad_id, unavailable.
  refused(reason: string): void;
  message(from: string, data: Uint8Array): void;
  // joined, admitted, left, host, kicked, ended, replaced.
  news(event: string, payload: Record<string, unknown>): void;
}

// The relay's limits (config/config.exs), a little under, so a burst of
// sends waits here rather than there (the relay makes a message over them
// wait too, keeping the order, but closes a participant whose messages
// pile up).
const MAX_MESSAGE = 256 * 1024;
const BYTES_PER_SECOND = 900 * 1024;
const MESSAGES_PER_SECOND = 180;
const BURST = 4;

const NEWS = ['joined', 'admitted', 'left', 'host', 'kicked', 'ended', 'replaced'];

interface Outgoing {
  to: string | null;
  data: Uint8Array;
}

export class Relay {
  readonly socket: Socket;
  private channel: Channel | null = null;
  private queue: Outgoing[] = [];
  private pumping: ReturnType<typeof setTimeout> | null = null;
  private bytes = BYTES_PER_SECOND * BURST;
  private messages = MESSAGES_PER_SECOND * BURST;
  private last = performance.now();
  private closed = false;

  // `params` for the join: { role, admit } for a new session, then the
  // host's token (set by `rejoinWith`) for every join after.
  constructor(
    readonly session: string,
    private params: Record<string, unknown>,
    private readonly events: RelayEvents,
  ) {
    this.socket = new Socket('/socket', {
      reconnectAfterMs: (tries) => [500, 1000, 2000, 5000][tries - 1] ?? 5000,
    });
    this.socket.connect();
    const channel = this.socket.channel(`live:${session}`, () => this.params);
    this.channel = channel;
    channel.on('m', (payload: ArrayBuffer) => {
      const bytes = new Uint8Array(payload);
      const size = bytes[0];
      const from = new TextDecoder().decode(bytes.subarray(1, 1 + size));
      this.events.message(from, bytes.subarray(1 + size));
    });
    for (const event of NEWS)
      channel.on(event, (payload: Record<string, unknown>) => {
        this.events.news(event, payload);
        if (['kicked', 'ended', 'replaced'].includes(event)) this.close();
      });
    channel
      .join()
      .receive('ok', (joined: Joined) => this.events.joined(joined))
      .receive('error', ({ reason }: { reason: string }) => {
        this.events.refused(reason);
        this.close();
      });
  }

  // For a bug hunt: what waits to go out, and the connection's state.
  debug() {
    return {
      socket: this.socket.connectionState(),
      channel: (this.channel as unknown as { state?: string } | null)?.state ?? 'none',
      queued: this.queue.length,
      queuedBytes: this.queue.reduce((sum, message) => sum + message.data.length, 0),
      waitingForBudget: this.pumping !== null,
      closed: this.closed,
    };
  }

  // Later joins (after a lost connection) as `params`: a host's token.
  rejoinWith(params: Record<string, unknown>): void {
    this.params = params;
  }

  broadcast(data: Uint8Array): void {
    this.enqueue({ to: null, data });
  }

  send(to: string, data: Uint8Array): void {
    this.enqueue({ to, data });
  }

  // A host's command: kick, admit ({id}), admission ({on}), end.
  command(event: string, payload: Record<string, unknown> = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.channel) return reject(new Error('not connected'));
      this.channel
        .push(event, payload)
        .receive('ok', () => resolve())
        .receive('error', ({ reason }: { reason: string }) => reject(new Error(reason)))
        .receive('timeout', () => reject(new Error('timeout')));
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pumping) clearTimeout(this.pumping);
    this.queue = [];
    this.channel?.leave();
    this.channel = null;
    this.socket.disconnect();
  }

  private enqueue(message: Outgoing): void {
    if (this.closed) return;
    if (message.data.length > MAX_MESSAGE) throw new Error('message too large for the relay');
    this.queue.push(message);
    this.pump();
  }

  // Sends what the budget allows, then waits for more of it.
  private pump(): void {
    if (this.pumping || this.closed) return;
    const now = performance.now();
    const elapsed = (now - this.last) / 1000;
    this.last = now;
    this.bytes = Math.min(BYTES_PER_SECOND * BURST, this.bytes + BYTES_PER_SECOND * elapsed);
    this.messages = Math.min(
      MESSAGES_PER_SECOND * BURST,
      this.messages + MESSAGES_PER_SECOND * elapsed,
    );
    while (this.queue.length) {
      const next = this.queue[0];
      if (this.bytes < next.data.length || this.messages < 1) break;
      this.queue.shift();
      this.bytes -= next.data.length;
      this.messages -= 1;
      this.push(next);
    }
    if (this.queue.length) {
      const wait = Math.max(
        (this.queue[0].data.length - this.bytes) / BYTES_PER_SECOND,
        (1 - this.messages) / MESSAGES_PER_SECOND,
      );
      this.pumping = setTimeout(
        () => {
          this.pumping = null;
          this.pump();
        },
        Math.max(10, wait * 1000),
      );
    }
  }

  private push({ to, data }: Outgoing): void {
    if (!this.channel) return;
    let payload: Uint8Array;
    if (to === null) payload = data;
    else {
      const id = new TextEncoder().encode(to);
      payload = new Uint8Array(1 + id.length + data.length);
      payload[0] = id.length;
      payload.set(id, 1);
      payload.set(data, 1 + id.length);
    }
    // Phoenix sends an ArrayBuffer as a binary frame.
    const buffer = payload.buffer.slice(
      payload.byteOffset,
      payload.byteOffset + payload.byteLength,
    );
    this.channel
      .push(to === null ? 'b' : 's', buffer as unknown as object)
      // Sent again it would come after later ones, which the receiver
      // drops as replayed: a refused message is lost. The relay refuses
      // one to someone gone (`unknown`), whose connections close anyway.
      .receive('error', ({ reason }: { reason: string }) =>
        console.warn(`live session: the relay refused a message (${reason})`),
      );
  }
}
