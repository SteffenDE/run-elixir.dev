import { describe, expect, it } from 'vitest';
import {
  HOST_PROTOCOL,
  SW_PROTOCOLS,
  announcedProtocol,
  hosted,
  isOwnFrame,
  negotiate,
} from '@/runtime/swProtocol';

describe('the service worker protocol', () => {
  it('reads the protocol a host or a document names, and none as none', () => {
    expect(announcedProtocol({ protocol: 1 })).toBe(1);
    expect(announcedProtocol({ protocol: 3 })).toBe(3);
    expect(announcedProtocol({})).toBe(0);
    expect(announcedProtocol({ protocol: 'two' })).toBe(0);
    expect(announcedProtocol({ protocol: 0 })).toBe(0);
    expect(announcedProtocol({ protocol: 1.5 })).toBe(0);
  });

  it('answers a host in the protocol it asked for, within its window', () => {
    expect(negotiate(1, [1, 2])).toBe(1);
    expect(negotiate(2, [1, 2])).toBe(2);
    // A host newer than the worker, one older than its window, and one
    // that names none.
    expect(negotiate(3, [1, 2])).toBeNull();
    expect(negotiate(1, [2, 3])).toBeNull();
    expect(negotiate(0, [1, 2])).toBeNull();
  });

  it('speaks the protocol its own hosts do', () => {
    expect(SW_PROTOCOLS).toContain(HOST_PROTOCOL);
    expect(hosted(HOST_PROTOCOL)).toEqual({
      kind: 'hosted',
      protocol: HOST_PROTOCOL,
      protocols: SW_PROTOCOLS,
    });
  });

  it('refuses a protocol it does not speak, naming those it does', () => {
    expect(hosted(2, [1])).toEqual({ kind: 'hosted', protocol: null, protocols: [1] });
  });

  it('leaves the packages’ pages to the network, never the app’s paths', () => {
    expect(isOwnFrame('/npm/@elixir-playground/runtime@1.0.0+3f2a9c1b04de/relay.html')).toBe(true);
    expect(isOwnFrame('/relay.html')).toBe(false);
    expect(isOwnFrame('/')).toBe(false);
    expect(isOwnFrame('/npm/left-pad')).toBe(false);
    expect(isOwnFrame('/users/relay.html')).toBe(false);
  });
});
