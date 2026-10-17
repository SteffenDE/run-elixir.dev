// wasm_host.c's side: hard links through the mounted file system (the
// playground's trees, app/src/runtime/beam/treefs.ts and sharedfs.ts, have
// a link of their own; Emscripten's file system has none).
addToLibrary({
  wasm_host_pid__proxy: 'sync',
  wasm_host_pid__sig: 'i',
  wasm_host_pid: () => Module['beamPid'] ?? 1000 + Math.floor(Math.random() * 30000),

  wasm_host_linkat__proxy: 'sync',
  wasm_host_linkat__sig: 'iipipi',
  wasm_host_linkat__deps: ['$FS', '$SYSCALLS', '$PATH', '$ERRNO_CODES'],
  wasm_host_linkat: (olddirfd, oldpath, newdirfd, newpath, flags) => {
    try {
      const from = SYSCALLS.calculateAt(olddirfd, UTF8ToString(oldpath));
      const to = SYSCALLS.calculateAt(newdirfd, UTF8ToString(newpath));
      // AT_SYMLINK_FOLLOW
      const source = FS.lookupPath(from, { follow: !!(flags & 0x400) }).node;
      const parent = FS.lookupPath(PATH.dirname(to), { follow: true }).node;
      if (source.mount !== parent.mount) return -{{{ cDefs.EXDEV }}};
      const fs = source.mount.opts?.fs;
      if (!fs?.link) return -{{{ cDefs.EMLINK }}};
      const real = (node) => {
        const parts = [];
        for (; node.parent !== node; node = node.parent) parts.push(node.name);
        return PATH.join(node.mount.opts.root, ...parts.reverse());
      };
      fs.link(real(source), PATH.join2(real(parent), PATH.basename(to)));
      return 0;
    } catch (e) {
      if (e.code && ERRNO_CODES[e.code]) return -ERRNO_CODES[e.code];
      if (e.name === 'ErrnoError') return -e.errno;
      throw e;
    }
  },
});
