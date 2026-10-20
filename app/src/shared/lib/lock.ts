// One page runs a project at a time: it holds the project's Web Lock for
// as long as it runs it. Another page that wants the project asks the
// holder to let go (over a BroadcastChannel); the holder keeps what it
// changed, stops, and releases. A holder that does not answer loses the
// lock after a while anyway.
import { projectLock } from './storage';

const ANSWER_MS = 5000;

let release: (() => void) | null = null;
let onRequested: (() => Promise<void>) | null = null;
let onLost: (() => void) | null = null;
let requests: BroadcastChannel | null = null;

const channel = (id: string) => new BroadcastChannel(projectLock(id));

function hold(id: string, options: LockOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let granted = false;
    navigator.locks
      .request(projectLock(id), options, (lock) => {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        granted = true;
        resolve(true);
        listen(id);
        return new Promise<void>((done) => {
          release = done;
        });
      })
      // Stolen (another page runs the project now), or given up waiting.
      .catch(() => (granted ? onLost?.() : resolve(false)));
  });
}

function listen(id: string) {
  const asked = channel(id);
  requests = asked;
  asked.onmessage = async ({ data }) => {
    if (data !== 'release') return;
    asked.close();
    if (requests === asked) requests = null;
    await onRequested?.().catch(() => {});
    release?.();
    release = null;
    onLost?.();
  };
}

// Resolves when the page that runs project `id` lets it go: it leaves,
// closes or crashes (the browser lets its locks go). A shared request
// waits for the holder, and lets go at once; rejects once `signal` aborts.
export async function whenReleased(id: string, signal: AbortSignal): Promise<void> {
  await navigator.locks.request(projectLock(id), { mode: 'shared', signal }, () => undefined);
}

// Take the project's lock if no other page holds it.
export function claimProject(id: string): Promise<boolean> {
  return hold(id, { ifAvailable: true });
}

// Take the project's lock from the page that holds it.
export async function takeOverProject(id: string): Promise<void> {
  const asking = channel(id);
  asking.postMessage('release');
  asking.close();
  const waiting = new AbortController();
  const timer = setTimeout(() => waiting.abort(), ANSWER_MS);
  const taken = await hold(id, { signal: waiting.signal });
  clearTimeout(timer);
  if (!taken) await hold(id, { steal: true });
}

// Let the project go: the page goes to another of the apex's pages in
// place (navigate.ts), as a load would let it go.
export function releaseProject(): void {
  requests?.close();
  requests = null;
  release?.();
  release = null;
  onRequested = null;
  onLost = null;
}

// requested: what to do before letting go (keep the changes, stop the
// nodes); lost: the project runs elsewhere now.
export function onProjectRelease(requested: () => Promise<void>, lost: () => void): void {
  onRequested = requested;
  onLost = lost;
}
