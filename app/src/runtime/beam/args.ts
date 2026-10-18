// erl's command line as the playground gives it (worker/index.ts,
// build.py), for the Emscripten BEAM, which takes the emulator's own: what
// erlexec would pass. `+Flag value` before -extra becomes the
// emulator's `-Flag value`, and init gets the installation's root (/rotp),
// boot script and home, gen_tcp the socket backend (beam/
// socket), and distribution, for a node given -sname or -name, its carrier
// over the socket module (docs/distribution.md).

// Emulator flags without a value.
const BARE = new Set(['+B', '+Bc', '+Bd', '+Bi', '+c', '+d', '+r']);

// No allocators of erts' own: on Emscripten `mmap` is malloc, whose heap
// their carriers of changing sizes fragment past any limit, and a super
// carrier costs its whole size up front (beam/README.md);
// mimalloc takes each allocation itself.
const EMULATOR = ['-Mea', 'min'];

export function beamArgs(args: string[], home = '/work'): string[] {
  const emulator = [...EMULATOR];
  const init: string[] = [];
  let extra = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (extra) init.push(arg);
    else if (arg === '-extra') {
      extra = true;
      init.push(arg);
    } else if (arg.startsWith('+') && arg.length > 1) {
      emulator.push('-' + arg.slice(1));
      const next = args[i + 1];
      if (!BARE.has(arg) && next !== undefined && !/^[-+]/.test(next)) emulator.push(args[++i]);
    } else init.push(arg);
  }
  const boot = init.includes('-boot') ? [] : ['-boot', '/rotp/bin/start'];
  return [
    ...emulator,
    '--',
    '-root',
    '/rotp',
    '-bindir',
    '/rotp/bin',
    '-progname',
    'erl',
    '-home',
    home,
    '-kernel',
    'inet_backend',
    'socket',
    '-proto_dist',
    'inet_epmd',
    '-inet_epmd',
    'socket',
    // os_mon's memsup only: its port program is the node's (programs.ts);
    // cpu_sup's and disksup's (df through sh) are not.
    '-os_mon',
    'start_cpu_sup',
    'false',
    '-os_mon',
    'start_disksup',
    'false',
    '-os_mon',
    'start_os_sup',
    'false',
    ...boot,
    ...init,
  ];
}
