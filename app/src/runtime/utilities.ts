// Small POSIX utilities that start other programs, as processes of the
// table (processes.ts): coreutils.wasm has neither, and a host's `env` or
// `xargs` would start the host's programs, not the table's.
import { feed, share, writeAll, type Processes, type Program } from './processes';

const encoder = new TextEncoder();

// env [-i] [-u NAME]… [NAME=VALUE]… [COMMAND ARGS…]: COMMAND with that
// environment, else the environment printed.
export function envProgram(processes: Processes): Program {
  return async (child, { args, cwd, env, stdio }) => {
    let vars = { ...env };
    let at = 0;
    for (; at < args.length; at++) {
      const arg = args[at];
      if (arg === '-i' || arg === '-' || arg === '--ignore-environment') vars = {};
      else if (arg === '-u' || arg === '--unset') delete vars[args[++at]];
      else if (arg === '--') {
        at++;
        break;
      } else break;
    }
    for (; at < args.length && /^[^=]+=/.test(args[at]); at++) {
      const split = args[at].indexOf('=');
      vars[args[at].slice(0, split)] = args[at].slice(split + 1);
    }
    if (at === args.length) {
      const text = Object.entries(vars)
        .map(([name, value]) => `${name}=${value}\n`)
        .join('');
      return (await writeAll(stdio[1], encoder.encode(text), child, null)) ? 0 : 141;
    }
    const status = await processes.run({
      program: args[at],
      args: args.slice(at + 1),
      cwd,
      env: vars,
      stdio: stdio.map((entry) => share(entry)) as typeof stdio,
    });
    if (status === null) {
      await writeAll(
        stdio[2],
        encoder.encode(`env: '${args[at]}': No such file or directory\n`),
        child,
        null,
      );
      return 127;
    }
    return status;
  };
}

// xargs [-0] [-n MAX] [-r] [COMMAND ARGS…]: COMMAND (echo) with the words
// of its input appended, MAX at a time (all by default); none with -r and
// no input. Quotes and backslashes in the input are as POSIX's.
export function xargsProgram(processes: Processes): Program {
  return async (child, { args, cwd, env, stdio }) => {
    let nul = false;
    let max = Infinity;
    let skipEmpty = false;
    let at = 0;
    for (; at < args.length; at++) {
      const arg = args[at];
      if (arg === '-0' || arg === '--null') nul = true;
      else if (arg === '-r' || arg === '--no-run-if-empty') skipEmpty = true;
      else if (arg === '-n') max = Number(args[++at]);
      else if (/^-n\d+$/.test(arg)) max = Number(arg.slice(2));
      else if (arg === '--') {
        at++;
        break;
      } else break;
    }
    const command = args.length > at ? args.slice(at) : ['echo'];
    const parts: Uint8Array[] = [];
    await feed(
      stdio[0],
      (bytes) => void (bytes && parts.push(bytes)),
      async () => {},
      () => false,
      null,
    );
    const decoder = new TextDecoder();
    const input =
      parts.map((part) => decoder.decode(part, { stream: true })).join('') + decoder.decode();
    const words = nul ? input.split('\0').filter((word) => word.length) : splitWords(input);
    if (!words.length && skipEmpty) return 0;
    let worst = 0;
    for (let from = 0; from < Math.max(words.length, 1); from += max) {
      const status = await processes.run({
        program: command[0],
        args: [...command.slice(1), ...words.slice(from, from + max)],
        cwd,
        env,
        stdio: stdio.map((entry) => share(entry)) as typeof stdio,
      });
      if (status === null) {
        await writeAll(
          stdio[2],
          encoder.encode(`xargs: ${command[0]}: No such file or directory\n`),
          child,
          null,
        );
        return 127;
      }
      if (status === 255) return 124;
      if (status) worst = 123;
    }
    return worst;
  };
}

// Words as xargs splits them: blanks between, '…', "…" and \ quoting.
function splitWords(input: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = null;
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      word ??= '';
    } else if (c === '\\' && i + 1 < input.length) word = (word ?? '') + input[++i];
    else if (/\s/.test(c)) {
      if (word !== null) words.push(word);
      word = null;
    } else word = (word ?? '') + c;
  }
  if (word !== null) words.push(word);
  return words;
}

// By name, for a resolver (worker/index.ts; setup.ts puts them on PATH).
export const UTILITIES: Record<string, (processes: Processes) => Program> = {
  env: envProgram,
  xargs: xargsProgram,
};
