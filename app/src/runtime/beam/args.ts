// erl's command line as the playground gives it to Rust-OTP (worker/
// index.ts, build.py), for the Emscripten BEAM, which takes the emulator's
// own: what erlexec would pass. `+Flag value` before -extra becomes the
// emulator's `-Flag value`, and init gets the installation's root (/rotp),
// boot script and home, and gen_tcp the socket backend (playground/beam/
// socket).

// Emulator flags without a value.
const BARE = new Set(['+B', '+Bc', '+Bd', '+Bi', '+c', '+d', '+r']);

// The super carrier: on Emscripten `mmap` is malloc, whose heap carriers of
// changing sizes fragment past any limit; erts places them in this region
// itself, and outside it once it is full (playground/beam/README.md).
const EMULATOR = ['-MMscs', '1024', '-MMsco', 'false'];

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
    ...boot,
    ...init,
  ];
}
