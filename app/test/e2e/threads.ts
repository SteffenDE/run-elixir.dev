// WebKit's web processes' threads, from /proc (Linux), for a failed test's
// report (fixtures.ts): which threads use CPU and where the others sleep.
// A BEAM thread that spins shows as a worker thread at ~100%; a deadlock or
// a lost wake-up as every thread asleep, the BEAM's on futexes. Playwright
// starts the browser, so its processes are this runner's descendants,
// whose /proc files it may read.
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const WEB_PROCESS = /^(WPEWebProcess|WebKitWebProcess)$/;

const read = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
};

interface Sample {
  name: string;
  state: string;
  ticks: number;
  wchan: string | null;
  syscall: string | null;
}

// A thread's name, state, CPU ticks so far, and what it waits in.
function sample(pid: string, tid: string): Sample | null {
  const stat = read(`/proc/${pid}/task/${tid}/stat`);
  if (!stat) return null;
  // The name is in parentheses and may hold spaces; the fields follow it.
  const close = stat.lastIndexOf(')');
  const name = stat.slice(stat.indexOf('(') + 1, close);
  const fields = stat.slice(close + 2).split(' ');
  const syscall = read(`/proc/${pid}/task/${tid}/syscall`);
  return {
    name,
    state: fields[0],
    ticks: Number(fields[11]) + Number(fields[12]),
    wchan: read(`/proc/${pid}/task/${tid}/wchan`),
    // The syscall's number and its first argument (a futex's address).
    syscall: syscall?.split(' ').slice(0, 2).join(' ') ?? null,
  };
}

function samples(): Map<string, Sample> {
  const found = new Map<string, Sample>();
  if (!existsSync('/proc')) return found;
  for (const pid of readdirSync('/proc').filter((entry) => /^\d+$/.test(entry))) {
    if (!WEB_PROCESS.test(read(`/proc/${pid}/comm`) ?? '')) continue;
    let tids: string[] = [];
    try {
      tids = readdirSync(`/proc/${pid}/task`);
    } catch {}
    for (const tid of tids) {
      const taken = sample(pid, tid);
      if (taken) found.set(`${pid}/${tid}`, taken);
    }
  }
  return found;
}

// Two samples `millis` apart: each web process's threads, the busy ones
// alone and the rest counted by name, state and where they wait.
export async function webProcessThreads(millis = 2000): Promise<unknown> {
  const before = samples();
  if (!before.size) return 'no WebKit web process found in /proc';
  await new Promise((resolve) => setTimeout(resolve, millis));
  const after = samples();
  const hz = 100;
  const processes: Record<string, { busy: string[]; idle: Record<string, number> }> = {};
  // `busy`: the threads that used CPU, and the workers; `idle`: the others.
  for (const [key, now] of after) {
    const pid = key.split('/')[0];
    const entry = (processes[pid] ??= { busy: [], idle: {} });
    const was = before.get(key);
    const cpu = was ? ((now.ticks - was.ticks) / hz / (millis / 1000)) * 100 : 0;
    const where = `${now.state} ${now.wchan ?? '?'} ${now.syscall ?? ''}`.trim();
    // Workers one by one (the BEAM's threads are among them), with the
    // futex each waits on.
    if (cpu >= 5 || /Worker/i.test(now.name))
      entry.busy.push(`${now.name} [${key}] ${cpu.toFixed(0)}% ${where}`);
    else {
      const idle = `${now.name}: ${now.state} ${now.wchan ?? '?'}`;
      entry.idle[idle] = (entry.idle[idle] ?? 0) + 1;
    }
  }
  return processes;
}
