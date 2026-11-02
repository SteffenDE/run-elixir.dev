// The elixir package's descriptor for a build (its index.js:
// elixir('1.20.4-otp-29')): Elixir's version, the OTP it runs on, and
// its fs layer, which the site's build prepares below the package
// (prepare.ts) and create() reads (playground.layer).
import { DEFAULT, buildPath, parseBuild } from './builds.js';

export { BUILDS, DEFAULT } from './builds.js';

export interface Descriptor {
  name: string;
  version: string;
  base: string;
  files: Record<string, { size: number; sha256: string }>;
  peerDependencies?: Record<string, string>;
  playground: Record<string, unknown>;
}

export function described(descriptor: Descriptor, build: string = DEFAULT): Descriptor {
  const { elixir, otp } = parseBuild(build);
  return {
    ...descriptor,
    playground: {
      ...descriptor.playground,
      elixir,
      requires: { otp: `^${otp}.0.0` },
      layer: `${buildPath(build)}fs.json`,
    },
  };
}
