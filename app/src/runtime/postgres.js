// Postgres for the node: a connection Postgrex makes to the page (host.js
// serve) carries the wire protocol to PGlite. Messages go to
// execProtocolRaw whole and in order, one connection at a time (PGlite is
// one session, which is why the app's pool has one connection).
// database(): the PGlite, a promise; asked for on the first message.
export function postgres(database) {
  let queue = Promise.resolve();
  return (connection) => {
    let buffer = new Uint8Array(0);
    let started = false;
    const take = (count) => {
      const out = buffer.slice(0, count);
      buffer = buffer.slice(count);
      return out;
    };
    connection.ondata = (bytes) => {
      const joined = new Uint8Array(buffer.length + bytes.length);
      joined.set(buffer);
      joined.set(bytes, buffer.length);
      buffer = joined;
      const messages = [];
      let terminate = false;
      for (;;) {
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        if (!started) {
          if (buffer.length < 8) break;
          const length = view.getInt32(0);
          if (buffer.length < length) break;
          const code = view.getInt32(4);
          const message = take(length);
          // SSLRequest, GSSENCRequest: not here.
          if (code === 80877103 || code === 80877104) {
            connection.write(new Uint8Array([78]));
            continue;
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
      queue = queue
        .then(async () => (terminate && batch.length === 5 ? new Uint8Array(0) : (await database()).execProtocolRaw(batch)))
        .then((out) => {
          if (out.length) connection.write(out);
          if (terminate) connection.close();
        })
        .catch((error) => {
          console.error('postgres:', error);
          connection.close();
        });
    };
  };
}
