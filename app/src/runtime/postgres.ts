// Postgres for the node: a connection Postgrex makes to the page (host/node.ts
// serve) carries the wire protocol to PGlite. Messages go to
// execProtocolRaw whole and in order. PGlite is one session, so the pool's
// connections take turns: a connection that leaves the session in a
// transaction, or between a Parse and its Sync, holds it until a
// ReadyForQuery says idle; the others' messages wait (a connection that
// saw another's transaction would take it for its own). A transaction
// idle for JOIN_AFTER lets the waiting ones in, into it, except a new
// connection's startup: Ecto's migrator holds its lock in a transaction on
// one connection and migrates on another.
// database(): the PGlite, a promise; asked for on the first message.
import type { Connection } from './host/node';

// What the handler needs of PGlite.
export interface Database {
  execProtocolRaw(message: Uint8Array): Promise<Uint8Array>;
}

const JOIN_AFTER = 1000;

// Startup codes: SSLRequest and GSSENCRequest (declined), CancelRequest
// (a query cannot be stopped here: the connection just closes).
const SSL = 80877103;
const GSSENC = 80877104;
const CANCEL = 80877102;

// Query 'ROLLBACK'.
const ROLLBACK = (() => {
  const sql = new TextEncoder().encode('ROLLBACK\0');
  const query = new Uint8Array(5 + sql.length);
  query[0] = 81;
  new DataView(query.buffer).setInt32(1, 4 + sql.length);
  query.set(sql, 5);
  return query;
})();

// The transaction status of the last ReadyForQuery in a reply (I, T or E),
// or null when there is none.
function readyStatus(reply: Uint8Array): string | null {
  const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
  let status: string | null = null;
  for (let at = 0; at + 5 <= reply.length; at += 1 + view.getInt32(at + 1)) {
    if (reply[at] === 90) status = String.fromCharCode(reply[at + 5]);
  }
  return status;
}

// A connection's messages, or (connection null) the session's own.
interface Batch {
  connection: Connection | null;
  bytes: Uint8Array;
  startup: boolean;
  terminate: boolean;
}

export function postgres(database: () => Promise<Database>): (connection: Connection) => void {
  // The connections the session is with (none: anyone's turn), and since
  // when it has been idle in their transaction (null while a reply is
  // awaited, or between Parse and Sync). One batch runs at a time.
  const holders = new Set<Connection>();
  // The one connection between a Parse and its Sync: no other's messages
  // may come between, also not a holder's that joined the transaction (its
  // Parse would replace this one's unnamed statement: "unnamed prepared
  // statement does not exist" at the Bind).
  let midway: Connection | null = null;
  let idleSince: number | null = null;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const waiting: Batch[] = [];

  const next = (): Batch | undefined => {
    const turn = waiting.findIndex((batch) =>
      midway
        ? batch.connection === midway
        : !batch.connection || !holders.size || holders.has(batch.connection),
    );
    if (turn >= 0) return waiting.splice(turn, 1)[0];
    if (idleSince === null || midway) return undefined;
    const late = Date.now() - idleSince >= JOIN_AFTER;
    // Only a holder's node's connections join (the migrator's other one):
    // another node's would put its unnamed statements between a holder's
    // Parse and Bind.
    const nodes = new Set([...holders].map((holder) => holder.node));
    const joining = waiting.findIndex(
      (batch) => !batch.startup && !!batch.connection && nodes.has(batch.connection.node),
    );
    if (late && joining >= 0) return waiting.splice(joining, 1)[0];
    if (!late && joining >= 0 && !timer)
      timer = setTimeout(
        () => {
          timer = null;
          pump();
        },
        JOIN_AFTER - (Date.now() - idleSince),
      );
    return undefined;
  };

  const pump = (): void => {
    if (running) return;
    const batch = next();
    if (!batch) return;
    running = true;
    const { connection, bytes, terminate } = batch;
    const reply =
      terminate && bytes.length === 5
        ? Promise.resolve(new Uint8Array(0))
        : database().then((db) => db.execProtocolRaw(bytes));
    reply
      .then((out) => {
        if (!connection) return;
        const status = readyStatus(out);
        midway = status === null && !terminate ? connection : null;
        if (status === 'I') {
          holders.clear();
          idleSince = null;
        } else if (status === 'T' || status === 'E') {
          holders.add(connection);
          idleSince = Date.now();
        } else if (!terminate) {
          holders.add(connection);
          idleSince = null;
        }
        if (out.length) connection.write(out);
        if (terminate) {
          connection.close();
          gone(connection);
        }
      })
      .catch((error) => {
        console.error('postgres:', error);
        if (connection) {
          connection.close();
          gone(connection);
        }
      })
      .finally(() => {
        running = false;
        pump();
      });
  };

  // A connection gone: its waiting messages are dropped, and the
  // transaction it held alone is rolled back (nothing else would end it).
  const gone = (connection: Connection) => {
    if (midway === connection) midway = null;
    for (let i = waiting.length - 1; i >= 0; i--)
      if (waiting[i].connection === connection) waiting.splice(i, 1);
    if (!holders.delete(connection)) return;
    if (holders.size) return;
    idleSince = null;
    waiting.unshift({ connection: null, bytes: ROLLBACK, startup: false, terminate: false });
    pump();
  };

  return (connection) => {
    let buffer = new Uint8Array(0);
    let started = false;
    let closed = false;
    const take = (count: number) => {
      const out = buffer.slice(0, count);
      buffer = buffer.slice(count);
      return out;
    };
    connection.onclose = () => {
      closed = true;
      gone(connection);
    };
    connection.ondata = (bytes) => {
      if (closed) return;
      const wasStarted = started;
      const joined = new Uint8Array(buffer.length + bytes.length);
      joined.set(buffer);
      joined.set(bytes, buffer.length);
      buffer = joined;
      const messages: Uint8Array[] = [];
      let terminate = false;
      for (;;) {
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        if (!started) {
          if (buffer.length < 8) break;
          const length = view.getInt32(0);
          if (buffer.length < length) break;
          const code = view.getInt32(4);
          const message = take(length);
          if (code === SSL || code === GSSENC) {
            connection.write(new Uint8Array([78]));
            continue;
          }
          if (code === CANCEL) {
            closed = true;
            connection.close();
            return;
          }
          started = true;
          messages.push(message);
        } else {
          if (buffer.length < 5) break;
          const length = view.getInt32(1);
          if (buffer.length < 1 + length) break;
          if (buffer[0] === 88) terminate = true;
          messages.push(take(1 + length));
        }
      }
      if (!messages.length) return;
      const batch = new Uint8Array(messages.reduce((n, m) => n + m.length, 0));
      let at = 0;
      for (const m of messages) {
        batch.set(m, at);
        at += m.length;
      }
      waiting.push({ connection, bytes: batch, startup: !wasStarted, terminate });
      pump();
    };
  };
}
