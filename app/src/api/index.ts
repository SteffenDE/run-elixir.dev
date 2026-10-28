// @elixir-playground/api (docs/api.md): run an Elixir project in the
// browser, from this page.
//
//   import { create } from '@elixir-playground/api';
//   import otp from '@elixir-playground/otp-29.1.2';
//   import elixir from '@elixir-playground/elixir-1.20.4';
//   import standard from '@elixir-playground/standard';
//
//   const sandbox = await create({
//     plugins: [otp, elixir, standard],
//     project: { id: 'my-project', template: 'empty', persist: true },
//   });
//   const p = sandbox.sh('mix new hello && cd hello && mix test');
//
// The page that calls it is the project's apex: it keeps the project's
// stores and frames the usercontent domain's frames, which run its code.
export { create, Process, Sandbox, Stream } from './sandbox';
export type {
  ApexContext,
  ApexInstance,
  ApexPlugin,
  CreateOptions,
  DirEntry,
  Events,
  Exit,
  PackageDescriptor,
  Plugin,
  ProjectSource,
  RelayPolicy,
  RuntimeVersions,
  Service,
  SpawnOptions,
  Stat,
  TerminalOptions,
  WriteOptions,
} from './types';
export type { Signal } from '@/runtime/signals';
