// The `process` package (process/browser.js) as the runtime's bundles have
// it (vite.runtime.config.ts's alias), for readable-stream, which takes
// its nextTick from there: the package's runs on a timer of the worker's
// own, a task each, so a stream's end, destroy and close came apart, holding
// nothing in a Node.js process's loop and with promise jobs between them.
// Here it is the process's own nextTick (nodejs/process.ts), where there is
// a process, else a microtask.

type Own = { nextTick?: (fn: (...a: unknown[]) => void, ...args: unknown[]) => void };

const own = (): Own | undefined => (globalThis as { process?: Own }).process;

export function nextTick(fn: (...a: unknown[]) => void, ...args: unknown[]): void {
  const process = own();
  if (process && process !== shim && typeof process.nextTick === 'function')
    return process.nextTick(fn, ...args);
  queueMicrotask(() => fn(...args));
}

export const env: Record<string, string | undefined> = {};
export const stdout = undefined;
export const stderr = undefined;

const shim = { nextTick, env, stdout, stderr };
export default shim;
