// Whether a project may use the site's TCP relay (docs/relay.md), on the
// IDE's page on the apex: the project's code runs in its exec frame, on
// the usercontent domain, which asks here (`relayWay`) before it takes a
// connection to one of the relay's hosts. The answer, per project, is the
// apex's to keep; the project's settings change it later.
//
// For a connection to a host on the relay's list: the tailnet where
// Tailscale runs with an exit node (and the project did not refuse it);
// else the relay once allowed; else, unless refused, the user is asked
// (RelayDialog).
import { create } from 'zustand';
import { relayed } from '@/runtime/relay';
import { decide, offForGuests, useTailscale } from '@/tailscale/client';

// Which projects (by id; the temporary IEx is `iex`) may use the relay,
// { key: boolean }, in the apex's storage.
export const RELAY = 'playground-relay-projects';

// How a connection to a relayed host goes: the tailnet (its own consent
// still checked there), the relay, or neither (fetch(), which the host
// will refuse).
export type Way = 'tailnet' | 'relay' | 'none';

export function relayConsents(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(RELAY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

export function setRelayConsent(key: string, allowed: boolean | null): void {
  const all = relayConsents();
  if (allowed === null) delete all[key];
  else all[key] = allowed;
  localStorage.setItem(RELAY, JSON.stringify(all));
  if (key === project) useRelay.setState({ consent: allowed });
}

interface RelayState {
  // Whether this project may use the relay: true, false, or null (not
  // asked yet).
  consent: boolean | null;
  // The host a connection waiting for the user's answer is to
  // (RelayDialog).
  asking: string | null;
}

export const useRelay = create<RelayState>(() => ({ consent: null, asking: null }));

// The project this page runs (its key in RELAY); null on a page that runs
// none.
let project: string | null = null;
// Connections waiting for the user's answer.
let waiting: ((way: Way) => void)[] = [];

export function setRelayProject(key: string | null): void {
  if (key === null) answered('none');
  project = key;
  useRelay.setState({ consent: key === null ? null : (relayConsents()[key] ?? null) });
}

addEventListener('storage', ({ key }) => {
  if (key !== RELAY || project === null) return;
  const allowed = relayConsents()[project] ?? null;
  useRelay.setState({ consent: allowed });
  if (allowed !== null) answered(allowed ? 'relay' : 'none');
});

function answered(way: Way): void {
  useRelay.setState({ asking: null });
  for (const resolve of waiting.splice(0)) resolve(way);
}

// Tailscale runs here with an exit node, for this project's code.
export function exitNodeReady(): boolean {
  const { status } = useTailscale.getState();
  return status?.state === 'Running' && !!status.exitNode && !offForGuests();
}

// What the project's exec frame asks (exec/host.ts): how its connection
// to `host`, one of the relay's, goes.
export function relayWay(host: unknown): Way | Promise<Way> {
  if (project === null || typeof host !== 'string' || !relayed(host, 443)) return 'none';
  const tailnet = useTailscale.getState().consent;
  if (exitNodeReady() && tailnet !== false) return 'tailnet';
  const { consent, asking } = useRelay.getState();
  if (consent !== null) return consent ? 'relay' : 'none';
  if (asking === null) useRelay.setState({ asking: host });
  return new Promise((resolve) => waiting.push(resolve));
}

// The user's answer (RelayDialog): the relay for this project, Tailscale
// for it, or neither. Setting Tailscale up first answers nothing for
// good: its connection is refused, and the next one asks again.
export function decideRelay(answer: 'relay' | 'tailnet' | 'deny' | 'later'): void {
  if (project === null) return answered('none');
  if (answer === 'relay' || answer === 'deny') setRelayConsent(project, answer === 'relay');
  if (answer === 'tailnet') decide(true);
  answered(answer === 'relay' ? 'relay' : answer === 'tailnet' ? 'tailnet' : 'none');
}
