// The page program `npm` (docs/nodejs.md, npm), as the runtime imports it
// (docs/packages.md, "Page programs"): its node and sh are the exec
// frame's.
import type { PackageProgram } from '@elixir-playground/runtime/sdk/program';
import { npmProgram } from './npm';

const npm: PackageProgram = (process, context, host) =>
  npmProgram(() => host.programs())(process, context);
export default npm;
