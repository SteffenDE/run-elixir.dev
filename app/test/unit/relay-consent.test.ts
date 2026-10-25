import { beforeEach, describe, expect, test, vi } from 'vitest';

// The apex's storage and events, as a page has them.
vi.hoisted(() => {
  const items = new Map<string, string>();
  Object.assign(globalThis, {
    addEventListener: () => {},
    document: { querySelector: () => null },
    localStorage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
      removeItem: (key: string) => items.delete(key),
      clear: () => items.clear(),
    },
  });
});

const { decideRelay, relayConsents, relayWay, setRelayConsent, setRelayProject, useRelay } =
  await import('@/relay/client');
const { setTailnetProject, useTailscale } = await import('@/tailscale/client');

const running = (exitNode: string | null) =>
  useTailscale.setState({ status: { state: 'Running', exitNode } as never });

beforeEach(() => {
  localStorage.clear();
  useTailscale.setState({ status: null, consent: null });
  setTailnetProject('p1');
  setRelayProject('p1');
});

describe('how a connection to a relayed host goes', () => {
  test('not a relayed host, or no project: neither', () => {
    expect(relayWay('example.com')).toBe('none');
    setRelayProject(null);
    expect(relayWay('github.com')).toBe('none');
  });

  test('Tailscale with an exit node first, unless the project refused it', () => {
    running('exit-1');
    expect(relayWay('github.com')).toBe('tailnet');
    useTailscale.setState({ consent: false });
    setRelayConsent('p1', true);
    expect(relayWay('github.com')).toBe('relay');
  });

  test('without an exit node, the relay once allowed, never once refused', () => {
    running(null);
    setRelayConsent('p1', true);
    expect(relayWay('api.anthropic.com')).toBe('relay');
    setRelayConsent('p1', false);
    expect(relayWay('api.anthropic.com')).toBe('none');
  });

  test('else the user is asked, once for every connection waiting', async () => {
    const first = relayWay('github.com');
    const second = relayWay('codeberg.org');
    expect(useRelay.getState().asking).toBe('github.com');
    decideRelay('relay');
    await expect(first).resolves.toBe('relay');
    await expect(second).resolves.toBe('relay');
    expect(relayConsents()).toEqual({ p1: true });
    expect(useRelay.getState().asking).toBe(null);
  });

  test("don't allow is kept; setting Tailscale up is not", async () => {
    const later = relayWay('github.com');
    decideRelay('later');
    await expect(later).resolves.toBe('none');
    expect(relayConsents()).toEqual({});
    const denied = relayWay('github.com');
    decideRelay('deny');
    await expect(denied).resolves.toBe('none');
    expect(relayWay('github.com')).toBe('none');
  });

  test('allowing Tailscale there allows it for the project', async () => {
    running('exit-1');
    useTailscale.setState({ consent: false });
    const asked = relayWay('github.com');
    decideRelay('tailnet');
    await expect(asked).resolves.toBe('tailnet');
    expect(useTailscale.getState().consent).toBe(true);
  });
});
