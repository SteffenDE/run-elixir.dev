// The page program `esbuild` (docs/packages.md, "Page programs"), as
// the runtime imports it: the project's file changes are the host's.
import type { PackageProgram } from '@elixir-playground/runtime/sdk/program';
import { esbuild } from './esbuild';

const program: PackageProgram = (process, context, host) => esbuild(process, context, host.watch);
export default program;
