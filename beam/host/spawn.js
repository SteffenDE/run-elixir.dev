// wasm_spawn.c's side: programs for ports, run by the host
// (Module.beamSpawn, app/src/runtime/beam/run.ts, over the playground's
// programs), on the module's main thread (__proxy: 'sync'). When a
// program writes or exits, the port's id goes into the C side's ring
// (as socket.js's: control[0] written and notified, control[1] read,
// control[2] overflowed).
addToLibrary({
  $beamSpawned: { table: new Map(), next: 1, ring: 0, capacity: 0, control: 0 },

  $beamSpawnReady__deps: ['$beamSpawned'],
  $beamSpawnReady: (id) => {
    const s = beamSpawned;
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

  wasm_spawn_init__proxy: 'sync',
  wasm_spawn_init__sig: 'vpip',
  wasm_spawn_init__deps: ['$beamSpawned'],
  wasm_spawn_init: (ring, capacity, control) => {
    Object.assign(beamSpawned, { ring, capacity, control });
  },

  // NUL-terminated strings, `count` of them, from `at`.
  $beamStrings: (at, count) => {
    const out = [];
    for (let i = 0; i < count; i++) {
      const string = UTF8ToString(at);
      out.push(string);
      at += lengthBytesUTF8(string) + 1;
    }
    return out;
  },

  wasm_spawn_start__proxy: 'sync',
  wasm_spawn_start__sig: 'ippipi',
  wasm_spawn_start__deps: ['$beamSpawned', '$beamSpawnReady', '$beamStrings'],
  wasm_spawn_start: (program, args, argc, cwd, env, envc) => {
    const id = beamSpawned.next++;
    const variables = Object.fromEntries(
      beamStrings(env, envc).map((v) => [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)]),
    );
    const spawned = Module['beamSpawn']?.(
      UTF8ToString(program),
      beamStrings(args, argc),
      UTF8ToString(cwd),
      variables,
      () => beamSpawnReady(id),
    );
    // ENOENT, as Emscripten numbers it.
    if (!spawned) return -44;
    beamSpawned.table.set(id, spawned);
    return id;
  },

  wasm_spawn_read__proxy: 'sync',
  wasm_spawn_read__sig: 'iipi',
  wasm_spawn_read__deps: ['$beamSpawned'],
  wasm_spawn_read: (id, buffer, max) => {
    const bytes = beamSpawned.table.get(id)?.read(max);
    if (!bytes) return -1;
    HEAPU8.set(bytes, buffer);
    return bytes.length;
  },

  wasm_spawn_status__proxy: 'sync',
  wasm_spawn_status__sig: 'ii',
  wasm_spawn_status__deps: ['$beamSpawned'],
  wasm_spawn_status: (id) => beamSpawned.table.get(id)?.status() ?? 1,

  wasm_spawn_write__proxy: 'sync',
  wasm_spawn_write__sig: 'vipi',
  wasm_spawn_write__deps: ['$beamSpawned'],
  wasm_spawn_write: (id, data, length) => {
    beamSpawned.table.get(id)?.write(HEAPU8.slice(data, data + length));
  },

  wasm_spawn_kill__proxy: 'sync',
  wasm_spawn_kill__sig: 'vi',
  wasm_spawn_kill__deps: ['$beamSpawned'],
  wasm_spawn_kill: (id) => {
    beamSpawned.table.get(id)?.kill();
    beamSpawned.table.delete(id);
  },
});
