// POSIX's signals a process may be sent (the process API, docs/api.md),
// numbered as Linux's, and their names.
export const SIGNALS = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
} as const;

export type Signal = keyof typeof SIGNALS;

export const SIGNAL_NAMES: Record<number, Signal> = Object.fromEntries(
  Object.entries(SIGNALS).map(([name, number]) => [number, name as Signal]),
);
