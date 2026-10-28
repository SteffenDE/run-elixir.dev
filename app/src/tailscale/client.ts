// Tailscale for the apex's pages (docs/tailscale.md): the apex's shared
// worker (worker.ts), which every page of the apex reaches directly (no
// project's code runs on the apex: it runs in the exec frame, on the
// usercontent domain, docs/frames.md). A page follows the node's status,
// dismisses the setup hint, and, on a project's page, answers whether the
// project may use the tailnet, and gates what the project's exec frame
// asks of the node (tailnet.ts there): connections and DNS once the
// project may, and sharing its ports in the tailnet. Signing in and out,
// the exit node and the control server are the Tailscale page's
// (TailscalePage).
import { create } from 'zustand';
import { guestMayType, useLive } from '@/live/lib/store';
import { failure, NXDOMAIN, questionName } from '@/runtime/dns';
import type { Connection } from '@/runtime/host/node';
import { trace } from '@/runtime/trace';
import { siteManifest } from '@/shared/lib/build';
import { Site } from '@/runtime/packages/manifest';
import { SHARE_LOCK } from './protocol';
import type { Action, Exposure, Piece, Proto, Reply, Request, Status } from './protocol';

// The setup hint (TailscaleDialog) was dismissed: in the apex's storage,
// so it shows once in this browser, whichever project needed it.
export const HINT = 'playground-tailscale-hint';
// Which projects (by id; the temporary IEx is `iex`) may use the tailnet,
// { key: boolean }, in the apex's storage.
export const CONSENT = 'playground-tailscale-projects';
// The temporary IEx's key there.
export const IEX = 'iex';

export function consents(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(CONSENT) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

export function setConsent(key: string, allowed: boolean | null): void {
  const all = consents();
  if (allowed === null) delete all[key];
  else all[key] = allowed;
  localStorage.setItem(CONSENT, JSON.stringify(all));
}

// A port of this project's shared in the tailnet: being shared, shared,
// or why not.
export interface Shared {
  state: 'sharing' | 'shared' | 'failed';
  // The device's port it is (to be) shared at.
  as: number;
  error?: string;
  // Another project shares that port: a free one to share at instead, or
  // (busy) that it was taken.
  free?: number;
  busy?: boolean;
}

interface TailscaleState {
  // The node's status; null until the page follows it.
  status: Status | null;
  hintDismissed: boolean;
  // A request the browser would not make (its URL), while Tailscale is
  // not set up and the hint was not dismissed: TailscaleDialog shows it.
  blocked: string | null;
  // Whether this project may use the tailnet: true, false, or null (not
  // asked yet).
  consent: boolean | null;
  // What a connection waiting for the user's answer is to (ConsentDialog).
  asking: string | null;
  // This project's ports shared in the tailnet.
  shared: Record<number, Shared>;
}

export const useTailscale = create<TailscaleState>(() => ({
  status: null,
  hintDismissed: true,
  blocked: null,
  consent: null,
  asking: null,
  shared: {},
}));

// The project this page runs (its key in CONSENT), whose exec frame may
// ask for the tailnet; null on a page that runs none.
let project: string | null = null;

export function setTailnetProject(key: string | null): void {
  if (key === null) {
    // It stopped: its shared ports go, and what waited for an answer is
    // refused.
    for (const port of [...exposures.keys()]) unshare(port);
    for (const resolve of waiting.splice(0)) resolve(false);
    useTailscale.setState({ asking: null, blocked: null, shared: {} });
  }
  project = key;
  useTailscale.setState({ consent: key === null ? null : (consents()[key] ?? null) });
}

// The apex's shared worker, said hello to: the app's own (not the runtime
// package's: no other site runs it).
function workerPort(): MessagePort {
  const shared = new SharedWorker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'playground-tailscale',
  });
  // tailscale.wasm, through the site manifest (the worker waits for it).
  void siteManifest().then((ref) => {
    const tailscale = new Site(ref).tailscale();
    shared.port.postMessage({
      kind: 'hello',
      wasm: tailscale?.module.href ?? '',
      glue: tailscale?.glue.href ?? '',
    } satisfies Request);
  });
  return shared.port;
}

let worker: MessagePort | null = null;
const pending = new Map<number, { resolve(value?: string[]): void; reject(error: Error): void }>();
// DNS queries the worker has yet to answer, by id.
const queries = new Map<
  number,
  { resolve(answer: Uint8Array): void; reject(error: Error): void }
>();
let nextRequest = 0;

// Follow the node's status (once per page).
export function connectTailscale(): MessagePort {
  if (worker) return worker;
  worker = workerPort();
  useTailscale.setState({ hintDismissed: hintDismissedHere() });
  // For a bug hunt: the node's last log lines.
  Object.assign(window, { tailscale: { logs } });
  // Another page changed what projects may, or the hint.
  addEventListener('storage', () => {
    useTailscale.setState({ hintDismissed: hintDismissedHere() });
    if (project === null) return;
    const allowed = consents()[project] ?? null;
    useTailscale.setState({ consent: allowed });
    if (allowed !== null) answered(allowed);
  });
  worker.onmessage = ({ data }: MessageEvent<Reply>) => {
    if (data.kind === 'status') useTailscale.setState({ status: data.status });
    else if (data.kind === 'dns') {
      const waiter = queries.get(data.id);
      queries.delete(data.id);
      if (data.answer) waiter?.resolve(data.answer);
      else waiter?.reject(new Error(data.error ?? 'no answer'));
    } else {
      const waiter = pending.get(data.id);
      pending.delete(data.id);
      if (data.kind === 'logs') waiter?.resolve(data.lines);
      else if (data.error) waiter?.reject(new Error(data.error));
      else waiter?.resolve();
    }
  };
  return worker;
}

function hintDismissedHere(): boolean {
  try {
    return localStorage.getItem(HINT) === '1';
  } catch {
    return false;
  }
}

// Sign in or out, pick an exit node, set the control server (the
// Tailscale page).
export async function act(action: Action): Promise<void> {
  const id = ++nextRequest;
  const done = new Promise<void>((resolve, reject) =>
    pending.set(id, { resolve: () => resolve(), reject }),
  );
  connectTailscale().postMessage({ kind: 'act', id, action } satisfies Request);
  return done;
}

// The node's last log lines.
async function logs(): Promise<string[]> {
  const id = ++nextRequest;
  const lines = new Promise<string[]>((resolve, reject) =>
    pending.set(id, { resolve: (value) => resolve(value ?? []), reject }),
  );
  connectTailscale().postMessage({ kind: 'logs', id } satisfies Request);
  return lines;
}

// The hint, dismissed for good (TailscaleDialog).
export function dismissHint(): void {
  useTailscale.setState({ blocked: null, hintDismissed: true });
  try {
    localStorage.setItem(HINT, '1');
  } catch {
    // Not kept: it shows again in another page.
  }
}

// The node could not reach `what` (a URL, a name, an address) without
// Tailscale: with it not set up, the hint shows, once.
export function tailscaleBlocked(what: string): void {
  if (project === null || typeof what !== 'string') return;
  const { status, hintDismissed, blocked } = useTailscale.getState();
  if (status?.state === 'off' && !hintDismissed && !blocked)
    useTailscale.setState({ blocked: what.slice(0, 300) });
}

// Connections waiting for the user's answer (ConsentDialog).
let waiting: ((allowed: boolean) => void)[] = [];

function answered(allowed: boolean): void {
  useTailscale.setState({ asking: null });
  for (const resolve of waiting.splice(0)) resolve(allowed);
}

// Whether this project may use the tailnet: at once once the user said,
// else when they say (ConsentDialog asks, `what` being what the project's
// code reaches for).
function mayUse(what: string): boolean | Promise<boolean> {
  const { consent, asking } = useTailscale.getState();
  if (consent !== null) return consent;
  if (asking === null) useTailscale.setState({ asking: what.slice(0, 300) });
  return new Promise((resolve) => waiting.push(resolve));
}

// The user's answer (ConsentDialog, the Tailscale menu), kept by the apex.
export function decide(allowed: boolean): void {
  if (project === null) return;
  setConsent(project, allowed);
  useTailscale.setState({ consent: allowed });
  answered(allowed);
}

// The host of this page's live session chose no tailnet while a guest who
// may type into its terminals or edit its files (who runs code here) is
// in, and one is.
export function offForGuests(): boolean {
  return useLive.getState().tailnetOff && guestMayType();
}

// Whether the node would take the tailnet to `host` (a name or an
// address): this page runs a project, the device runs and has an exit
// node or `host` is the tailnet's, and it is not off for a live session's
// guests.
function routable(host: string): boolean {
  const { status } = useTailscale.getState();
  return (
    project !== null &&
    status?.state === 'Running' &&
    (!!status.exitNode || inTailnet(host, status)) &&
    !offForGuests()
  );
}

// 100.64.0.0/10 and fd7a:115c:a1e0::/48, Tailscale's addresses, or a
// MagicDNS name.
function inTailnet(host: string, status: Status): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  const v4 = name.match(/^100\.(\d+)\.\d+\.\d+$/);
  if (v4) return (Number(v4[1]) & 0xc0) === 64;
  if (name.replace(/^\[|\]$/g, '').startsWith('fd7a:115c:a1e0:')) return true;
  const suffix = status.magicDNSSuffix?.toLowerCase().replace(/\.$/, '');
  return !!suffix && name.endsWith(`.${suffix}`);
}

// What the project's exec frame asks (exec/host.ts, through tailnet.ts):
// it runs the project's code, so each is checked here.

// A connection to `host`:`port` through the tailnet, on `conn` (Piece):
// handed to the node when it would take the tailnet there and the project
// may (asked once, the call waiting for the answer); else false, and
// `conn` closed.
export async function tailnetDial(
  host: unknown,
  port: unknown,
  proto: unknown,
  conn: unknown,
): Promise<boolean> {
  if (!(conn instanceof MessagePort)) return false;
  const valid =
    typeof host === 'string' &&
    host.length > 0 &&
    host.length <= 255 &&
    Number.isInteger(port) &&
    (port as number) >= 1 &&
    (port as number) <= 65535 &&
    (proto === 'tcp' || proto === 'udp');
  if (!valid || !routable(host) || !(await mayUse(host)) || !routable(host)) {
    conn.close();
    return false;
  }
  connectTailscale().postMessage(
    { kind: 'dial', host, port: port as number, proto: proto as Proto } satisfies Request,
    [conn],
  );
  return true;
}

// The node's DNS (runtime/dns.ts): Tailscale's resolver while the device
// runs and this project may use it; else no such name (as without DNS),
// and the setup hint for it.
export async function tailnetResolve(query: unknown): Promise<Uint8Array> {
  if (!(query instanceof Uint8Array)) throw new Error('not a DNS message');
  const { status } = useTailscale.getState();
  const name = questionName(query);
  if (project !== null && status?.state === 'Running' && !offForGuests()) {
    if (await mayUse(name ?? 'a name')) {
      const id = ++nextRequest;
      const answer = new Promise<Uint8Array>((resolve, reject) =>
        queries.set(id, { resolve, reject }),
      );
      connectTailscale().postMessage({ kind: 'dns', id, query } satisfies Request);
      return answer;
    }
  } else if (name) tailscaleBlocked(name);
  return failure(query, NXDOMAIN);
}

// This project's ports shared in the tailnet, by the server's port: where
// its inbound connections come, and the lock that keeps it shared.
const exposures = new Map<number, { owner: MessagePort; release(): void }>();

const setShared = (port: number, shared: Shared | null) =>
  useTailscale.setState((state) => {
    const next = { ...state.shared };
    if (shared) next[port] = shared;
    else delete next[port];
    return { shared: next };
  });

// A Web Lock held until release(): the worker frees the port once it goes,
// with the page if nothing else.
function holdLock(name: string): Promise<() => void> {
  return new Promise((granted) => {
    void navigator.locks.request(name, () => new Promise<void>((release) => granted(release)));
  });
}

// Share the server on the node's `port` in the tailnet, at the device's
// port `as` (the same, unless another project shares that one): connections
// there go to the server the project runs (connect(port), playground.ts's
// connectServer). `take`: from the project that shares it.
export async function share(
  port: number,
  connect: (port: number) => Connection | null,
  { as = port, take = false }: { as?: number; take?: boolean } = {},
): Promise<void> {
  if (exposures.has(port) || project === null) return;
  setShared(port, { state: 'sharing', as });
  const lock = `${SHARE_LOCK}${crypto.randomUUID()}`;
  const release = await holdLock(lock);
  const channel = new MessageChannel();
  const owner = channel.port1;
  const exposure = { owner, release };
  exposures.set(port, exposure);
  const gone = () => {
    if (exposures.get(port) !== exposure) return false;
    exposures.delete(port);
    release();
    owner.close();
    return true;
  };
  owner.onmessage = ({ data, ports }: MessageEvent<Exposure>) => {
    if (data.kind === 'exposed') setShared(port, { state: 'shared', as });
    else if (data.kind === 'error') {
      if (gone()) setShared(port, { state: 'failed', as, error: data.message, free: data.free });
    } else if (data.kind === 'taken') {
      if (gone())
        setShared(port, {
          state: 'failed',
          as,
          error: `another project shares port ${as} now`,
          busy: true,
        });
    } else if (data.kind === 'inbound' && ports[0]) inbound(ports[0], connect(port));
  };
  connectTailscale().postMessage({ kind: 'expose', port: as, lock, take } satisfies Request, [
    channel.port2,
  ]);
}

export function unshare(port: number): void {
  const exposure = exposures.get(port);
  exposures.delete(port);
  setShared(port, null);
  if (!exposure) return;
  exposure.owner.postMessage({ kind: 'unexpose' } satisfies Exposure);
  exposure.owner.close();
  exposure.release();
}

// An inbound connection (its port) to the node's server, or closed if none
// listens now.
function inbound(conn: MessagePort, connection: Connection | null): void {
  trace('net', `tailnet → port ${connection?.port ?? '(none listens)'}`);
  if (!connection) {
    conn.postMessage({ kind: 'close' } satisfies Piece);
    return conn.close();
  }
  conn.postMessage({ kind: 'open' } satisfies Piece);
  connection.ondata = (bytes) => {
    const copy = bytes.slice();
    conn.postMessage({ kind: 'data', bytes: copy } satisfies Piece, [copy.buffer]);
  };
  connection.onend = () => conn.postMessage({ kind: 'end' } satisfies Piece);
  connection.onclose = () => {
    conn.postMessage({ kind: 'close' } satisfies Piece);
    conn.close();
  };
  conn.onmessage = ({ data }: MessageEvent<Piece>) => {
    if (data.kind === 'data') connection.write(data.bytes);
    else if (data.kind === 'end') connection.end();
    else if (data.kind === 'close') connection.close();
  };
}

// What the node is doing, in a few words, and how it looks: on (it can
// reach the internet), warn (it needs something), off or pending.
export function describe(status: Status): {
  label: string;
  tone: 'on' | 'warn' | 'off' | 'pending';
} {
  const trouble = status.error || status.warnings?.[0];
  if (trouble && status.state !== 'Running') return { label: trouble, tone: 'warn' };
  switch (status.state) {
    case 'off':
      return { label: 'not set up', tone: 'off' };
    case 'NeedsLogin':
      return { label: 'signed out', tone: 'warn' };
    case 'NeedsMachineAuth':
      return { label: 'waiting for approval in the admin console', tone: 'warn' };
    case 'Stopped':
      return { label: 'stopped', tone: 'warn' };
    case 'Running': {
      const exit = status.exitNodes.find((node) => node.id === status.exitNode);
      if (!status.exitNode) return { label: 'connected, no exit node', tone: 'warn' };
      if (exit && !exit.online)
        return { label: `connected, exit node ${exit.name} offline`, tone: 'warn' };
      return { label: `connected through ${exit?.name ?? 'an exit node'}`, tone: 'on' };
    }
    case 'waiting':
      return { label: 'running in another tab of an older version', tone: 'pending' };
    default:
      return { label: 'starting', tone: 'pending' };
  }
}
