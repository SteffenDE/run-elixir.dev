// The elixir package's descriptors for a build (its index.js:
// elixir('1.20.4-otp-29', { archives })): Elixir's version, the OTP it
// runs on, and its fs layer, and its Mix archives' layers, which the
// site's build prepares below the package (prepare.ts) and create() reads
// (playground.layer).
import { DEFAULT, archivePath, buildPath, parseBuild } from './builds.js';

export { BUILDS, DEFAULT } from './builds.js';

export interface Descriptor {
  name: string;
  version: string;
  base: string;
  files: Record<string, { size: number; sha256: string }>;
  peerDependencies?: Record<string, string>;
  playground: Record<string, unknown>;
}

// The package's own `playground` field (runtime/build.py's PACKAGES has
// the same): Elixir's scripts, its commands, and the rebar3 Mix builds
// rebar3 dependencies with.
export const PLAYGROUND = {
  bin: { elixir: 'bin/elixir', elixirc: 'bin/elixirc', iex: 'bin/iex', mix: 'bin/mix' },
  env: { MIX_REBAR3: 'mix/rebar3' },
};

export interface ElixirOptions {
  // Mix archives from Hex besides Hex, by name: their versions
  // ({ phx_new: '1.8.16' }), which the site's build prepares with the build.
  archives?: Record<string, string>;
}

// The build's descriptor, and one for each of its Mix archives (Hex's, and
// those in `options.archives`): layers below the project's MIX_HOME
// (builds.ts ARCHIVES), where Mix finds them and keeps what the project
// installs beside them. Each archive is a package of its own name
// (NAME/archives/ARCHIVE) at the package's base.
export function described(
  descriptor: Descriptor,
  build: string = DEFAULT,
  options: ElixirOptions = {},
): Descriptor[] {
  const { elixir, otp } = parseBuild(build);
  const archive = (name: string, version?: string): Descriptor => ({
    name: `${descriptor.name}/archives/${name}`,
    version: descriptor.version,
    base: descriptor.base,
    files: {},
    playground: { layer: `${archivePath(build, name, version)}fs.json` },
  });
  return [
    {
      ...descriptor,
      playground: {
        ...descriptor.playground,
        elixir,
        requires: { otp: `^${otp}.0.0` },
        layer: `${buildPath(build)}fs.json`,
      },
    },
    archive('hex'),
    ...Object.entries(options.archives ?? {}).map(([name, version]) => archive(name, version)),
  ];
}
