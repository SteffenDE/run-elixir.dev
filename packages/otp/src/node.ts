// An otp package's Node.js module (node.js): OTP's emulator under Node,
// through the runtime's harness (@elixir-playground/runtime/harness).
//
//   import { erl } from '@elixir-playground/otp-29.1.2/node';
//   const node = await erl(['-noshell', '-eval', 'io:format("~s~n", [erlang:system_info(otp_release)]), halt().']);
//   node.end();
//   const { status } = await node.done;
import { fileURLToPath } from 'node:url';
import { start, type HarnessNode, type HarnessOptions } from '@elixir-playground/runtime/harness';

// The package's directory (this module is at its root).
export const directory = fileURLToPath(new URL('.', import.meta.url));

export type ErlOptions = Omit<HarnessOptions, 'args' | 'site'>;

// erl with `args` (as erl takes them) on this OTP, with the packages in
// `options.packages` after it (an Elixir, the shell).
export function erl(args: string[], options: ErlOptions = {}): Promise<HarnessNode> {
  return start({ ...options, args, packages: [directory, ...(options.packages ?? [])] });
}
