// Linux's signal numbers, as os.constants.signals has them.
export const signals: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGCHLD: 17,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGWINCH: 28,
};

// A signal's name, given it or its number.
export const signalName = (signal: string | number) =>
  typeof signal === 'number'
    ? (Object.keys(signals).find((name) => signals[name] === signal) ?? `SIG${signal}`)
    : signal;
