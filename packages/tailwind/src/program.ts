// The page program `tailwind` (docs/packages.md, "Page programs"), as
// the runtime imports it: the project's file changes are the host's.
import type { PackageProgram } from '@elixir-playground/runtime/sdk/program';
import { tailwind } from './tailwind';

const program: PackageProgram = (process, context, host) => tailwind(process, context, host.watch);
export default program;
