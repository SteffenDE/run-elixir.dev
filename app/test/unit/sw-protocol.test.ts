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
  it('takes a host that names no protocol as protocol 1', () => {
    expect(announcedProtocol({})).toBe(1);
    expect(announcedProtocol({ protocol: undefined })).toBe(1);
    expect(announcedProtocol({ protocol: 'two' })).toBe(1);
    expect(announcedProtocol({ protocol: 0 })).toBe(1);
    expect(announcedProtocol({ protocol: 1.5 })).toBe(1);
    expect(announcedProtocol({ protocol: 3 })).toBe(3);
  });

  it('answers a host in the protocol it asked for, within its window', () => {
    expect(negotiate(1, [1, 2])).toBe(1);
    expect(negotiate(2, [1, 2])).toBe(2);
    // A host newer than the worker, and one older than its window.
    expect(negotiate(3, [1, 2])).toBeNull();
    expect(negotiate(1, [2, 3])).toBeNull();
  });

  it('speaks the protocol its own hosts do', () => {
    expect(SW_PROTOCOLS).toContain(HOST_PROTOCOL);
    expect(hosted('default', HOST_PROTOCOL)).toEqual({
      kind: 'hosted',
      key: 'default',
      protocol: HOST_PROTOCOL,
      protocols: SW_PROTOCOLS,
    });
  });

  it('refuses a protocol it does not speak, naming those it does', () => {
    expect(hosted('default', 2, [1])).toEqual({
      kind: 'hosted',
      key: 'default',
      protocol: null,
      protocols: [1],
    });
  });

  it('leaves the site’s own frames to the network, never the app’s paths', () => {
    expect(isOwnFrame('/relay.html')).toBe(true);
    expect(isOwnFrame('/exec.html')).toBe(true);
    expect(isOwnFrame('/npm/@elixir-playground/runtime@3.4.1/relay.html')).toBe(true);
    expect(isOwnFrame('/')).toBe(false);
    expect(isOwnFrame('/npm/left-pad')).toBe(false);
    expect(isOwnFrame('/users/relay.html')).toBe(false);
  });
});
