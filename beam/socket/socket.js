// prim_socket_nif.c's side in JavaScript: TCP over the playground's
// Network (app/src/runtime/wasi/net.ts), which the host passes as
// Module.beamNetwork. Every function runs on the module's main thread
// (__proxy: 'sync'), where the Network lives; the C side holds its
// socket's lock across each call.
//
// When a listener gets a connection or a connection data or its end, the
// socket's id goes into the C side's ring and its event thread is woken:
// control[0] counts the ids written (and is notified), control[1] those
// read, control[2] says the ring overflowed.
//
// Errors are negative errnos, as WASI numbers them (abi.ts): EAGAIN -6,
// EADDRINUSE -3, ECONNREFUSED -14, EBADF -8.
addToLibrary({
  $beamSockets: { table: new Map(), next: 1, ring: 0, capacity: 0, control: 0 },

  $beamSocketReady__deps: ['$beamSockets'],
  $beamSocketReady: (id) => {
    const s = beamSockets;
    if (Module['beamSocketTrace']) err(`socket ready ${id}`);
    if (!s.control) return;
    const control = s.control >> 2;
    const written = Atomics.load(HEAP32, control);
    if (written - Atomics.load(HEAP32, control + 1) >= s.capacity) {
      Atomics.store(HEAP32, control + 2, 1);
    } else {
      HEAP32[(s.ring >> 2) + (written >>> 0) % s.capacity] = id;
      Atomics.store(HEAP32, control, written + 1);
    }
    Atomics.notify(HEAP32, control);
  },

  // A connection's socket: its endpoint wakes the C side when it changes.
  $beamSocketConnection__deps: ['$beamSockets', '$beamSocketReady'],
  $beamSocketConnection: (endpoint) => {
    const id = beamSockets.next++;
    beamSockets.table.set(id, { endpoint });
    endpoint.notify = () => beamSocketReady(id);
    return id;
  },

  wasm_socket_init__proxy: 'sync',
  wasm_socket_init__sig: 'vpip',
  wasm_socket_init__deps: ['$beamSockets'],
  wasm_socket_init: (ring, capacity, control) => {
    Object.assign(beamSockets, { ring, capacity, control });
  },

  wasm_socket_listen__proxy: 'sync',
  wasm_socket_listen__sig: 'iip',
  wasm_socket_listen__deps: ['$beamSockets', '$beamSocketReady'],
  wasm_socket_listen: (port, boundPtr) => {
    if (Module['beamSocketTrace']) err(`listen ${[port, boundPtr]}`);
    const network = Module['beamNetwork'];
    const listening = network?.listen(port);
    if (!listening) return -3;
    const id = beamSockets.next++;
    beamSockets.table.set(id, { listener: listening.port, queue: listening.queue });
    network.onqueue ??= new Map();
    network.onqueue.set(listening.port, () => beamSocketReady(id));
    HEAP32[boundPtr >> 2] = listening.port;
    return id;
  },

  wasm_socket_accept__proxy: 'sync',
  wasm_socket_accept__sig: 'iip',
  wasm_socket_accept__deps: ['$beamSockets', '$beamSocketConnection'],
  wasm_socket_accept: (id, peerPtr) => {
    if (Module['beamSocketTrace']) err(`accept ${[id, peerPtr]}`);
    const network = Module['beamNetwork'];
    const socket = beamSockets.table.get(id);
    if (!socket?.queue) return -8;
    const waiting = socket.queue.shift();
    if (!waiting) return -6;
    const endpoint = network.waiting.get(waiting.id);
    network.waiting.delete(waiting.id);
    HEAP32[peerPtr >> 2] = waiting.port;
    return beamSocketConnection(endpoint);
  },

  // HTTPS by the page's fetch (the playground's ssl, patch 0020): a
  // connection to Module.beamHttpsGateway names its host and port in its
  // first line, then is the page's HTTPS connection there (Network.https),
  // over which the node writes plain HTTP.
  $beamHttpsGateway: (network) => {
    let real = null;
    let failed = false;
    let head = new Uint8Array(0);
    const gateway = {
      notify: null,
      get inbox() {
        return real ? real.inbox : [];
      },
      get eof() {
        return failed || (real ? real.eof : false);
      },
      take: (max) => (real ? real.take(max) : new Uint8Array(0)),
      peer: {
        send(bytes) {
          if (real) return real.peer.send(bytes);
          const joined = new Uint8Array(head.length + bytes.length);
          joined.set(head);
          joined.set(bytes, head.length);
          const newline = joined.indexOf(10);
          if (newline < 0) {
            head = joined;
            return;
          }
          const target = new TextDecoder().decode(joined.subarray(0, newline)).trim();
          const at = target.lastIndexOf(':');
          real = network.https(target.slice(0, at), Number(target.slice(at + 1)));
          if (!real) {
            failed = true;
            gateway.notify?.();
            return;
          }
          real.notify = () => gateway.notify?.();
          const rest = joined.subarray(newline + 1);
          if (rest.length) real.peer.send(rest);
        },
        end: () => real?.peer.end(),
        close: () => real?.peer.close(),
      },
    };
    return gateway;
  },

  wasm_socket_connect__proxy: 'sync',
  wasm_socket_connect__sig: 'ii',
  wasm_socket_connect__deps: ['$beamSocketConnection', '$beamHttpsGateway'],
  wasm_socket_connect: (port) => {
    const network = Module['beamNetwork'];
    if (network?.remote.https && port === Module['beamHttpsGateway'])
      return beamSocketConnection(beamHttpsGateway(network));
    const endpoint = network?.connect(port);
    if (!endpoint) return -14;
    return beamSocketConnection(endpoint);
  },

  wasm_socket_send__proxy: 'sync',
  wasm_socket_send__sig: 'iipi',
  wasm_socket_send__deps: ['$beamSockets'],
  wasm_socket_send: (id, data, length) => {
    if (Module['beamSocketTrace']) err(`send ${[id, data, length]}`);
    const endpoint = beamSockets.table.get(id)?.endpoint;
    if (!endpoint) return -8;
    endpoint.peer.send(HEAPU8.slice(data, data + length));
    return length;
  },

  // Bytes into `buffer`, 0 at the end, -6 when none have come.
  wasm_socket_recv__proxy: 'sync',
  wasm_socket_recv__sig: 'iipi',
  wasm_socket_recv__deps: ['$beamSockets'],
  wasm_socket_recv: (id, buffer, max) => {
    if (Module['beamSocketTrace']) err(`recv ${[id, buffer, max]}`);
    const endpoint = beamSockets.table.get(id)?.endpoint;
    if (!endpoint) return 0;
    const bytes = endpoint.take(max);
    if (bytes.length) {
      HEAPU8.set(bytes, buffer);
      return bytes.length;
    }
    return endpoint.eof ? 0 : -6;
  },

  // Whether a listener has connections waiting (how many), or a
  // connection data or its end.
  wasm_socket_pending__proxy: 'sync',
  wasm_socket_pending__sig: 'ii',
  wasm_socket_pending__deps: ['$beamSockets'],
  wasm_socket_pending: (id) => {
    if (Module['beamSocketTrace']) err(`pending ${[id]}`);
    const socket = beamSockets.table.get(id);
    if (!socket) return 0;
    if (socket.queue) return socket.queue.length;
    return socket.endpoint.inbox.length || socket.endpoint.eof ? 1 : 0;
  },

  wasm_socket_shutdown__proxy: 'sync',
  wasm_socket_shutdown__sig: 'vi',
  wasm_socket_shutdown__deps: ['$beamSockets'],
  wasm_socket_shutdown: (id) => {
    beamSockets.table.get(id)?.endpoint?.peer.end();
  },

  wasm_socket_close__proxy: 'sync',
  wasm_socket_close__sig: 'vi',
  wasm_socket_close__deps: ['$beamSockets'],
  wasm_socket_close: (id) => {
    if (Module['beamSocketTrace']) err(`close ${[id]}`);
    const socket = beamSockets.table.get(id);
    beamSockets.table.delete(id);
    if (!socket) return;
    if (socket.endpoint) {
      socket.endpoint.notify = null;
      socket.endpoint.peer.close();
    } else {
      const network = Module['beamNetwork'];
      network.unlisten(socket.listener);
      network.onqueue?.delete(socket.listener);
    }
  },
});
