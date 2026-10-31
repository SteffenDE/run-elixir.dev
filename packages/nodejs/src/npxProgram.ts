// The page program `npx` (docs/nodejs.md, npx), as the runtime imports it.
import type { PackageProgram } from '@elixir-playground/runtime/sdk/program';
import { npxProgram } from './npm';

const npx: PackageProgram = (process, context, host) =>
  npxProgram(() => host.programs())(process, context);
export default npx;
