// wasm_nifs.c's side: NIF libraries built to WebAssembly, each an
// instance the host keeps (Module.beamNifs, app/src/runtime/beam/run.ts
// over nif.ts's Nifs), on the module's main thread (__proxy: 'sync').
// An answer waits here until the C side, having made room, copies it.
addToLibrary({
  $beamNif: { answer: null, error: '' },

  // The library at `path` (the node's file): its id, or 0 (and the error).
  wasm_nif_open__proxy: 'sync',
  wasm_nif_open__sig: 'ip',
  wasm_nif_open__deps: ['$beamNif', '$FS'],
  wasm_nif_open: (path) => {
    const name = UTF8ToString(path);
    try {
      const opened = Module['beamNifs'].open(FS.readFile(name));
      if (typeof opened === 'number') return opened;
      beamNif.error = `${name}: ${opened}`;
    } catch (error) {
      beamNif.error = `${name}: ${error.code ?? error.message ?? error}`;
    }
    return 0;
  },

  wasm_nif_error__proxy: 'sync',
  wasm_nif_error__sig: 'ipi',
  wasm_nif_error__deps: ['$beamNif'],
  wasm_nif_error: (buffer, size) => stringToUTF8(beamNif.error, buffer, size),

  wasm_nif_request__proxy: 'sync',
  wasm_nif_request__sig: 'iipi',
  wasm_nif_request__deps: ['$beamNif'],
  wasm_nif_request: (id, data, size) => {
    beamNif.answer = Module['beamNifs'].call(id, HEAPU8.slice(data, data + size));
    return beamNif.answer ? beamNif.answer.length : -1;
  },

  wasm_nif_answer__proxy: 'sync',
  wasm_nif_answer__sig: 'vp',
  wasm_nif_answer__deps: ['$beamNif'],
  wasm_nif_answer: (buffer) => {
    if (beamNif.answer) HEAPU8.set(beamNif.answer, buffer);
    beamNif.answer = null;
  },
});
