// The precompiled Elixir builds the package was tested with (builds.hex.pm,
// v{VERSION}.zip), each with its SHA-256 as builds.txt lists it. The
// first is the default. Another build is prepared only when asked for
// (prepare's `untested`), checked against builds.txt.
export const BUILDS: Record<string, string> = {
  '1.20.4-otp-29': '7863c546cda13fecc949e562e326042451dacf8fd8698a36783cb71eeb223b46',
};

export const DEFAULT = Object.keys(BUILDS)[0];

// A build's name (1.20.4-otp-29): Elixir's version, and the OTP major
// it was compiled for, which the package requires.
export function parseBuild(build: string): { elixir: string; otp: number } {
  const found = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-otp-(\d+)$/.exec(build);
  if (!found) throw new Error(`${build}: not a precompiled Elixir build (such as ${DEFAULT})`);
  return { elixir: found[1], otp: Number(found[2]) };
}

// Where a build's layer is below the package's directory.
export const buildPath = (build: string) => `versions/${build}/`;

// Where a Mix archive's layer for a build is: Hex's, as Mix picked it
// (`hex`), or an archive at its version (`phx_new-1.8.16`).
export const archivePath = (build: string, name: string, version?: string) =>
  `${buildPath(build)}archives/${version ? `${name}-${version}` : name}/`;

// Where a node's Mix finds its archives: MIX_HOME's (setup.ts), the
// project's home, kept with it.
export const ARCHIVES = '/home/user/.mix/archives';
