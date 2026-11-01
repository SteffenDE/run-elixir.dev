// The page program `inotifywait` (docs/packages.md, "Page programs"), as
// the runtime imports it: the project's file changes are the host's.
import type { PackageProgram } from '@elixir-playground/runtime/sdk/program';
import { inotifywait } from './inotifywait';

const program: PackageProgram = (process, context, host) =>
  inotifywait(process, context, host.watch);
export default program;
