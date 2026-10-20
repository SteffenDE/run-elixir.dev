import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import { createDns } from '../../src/runtime/nodejs/dns';

describe('dns.lookup', () => {
  test('promisified answers its address and family, as Node’s', async () => {
    const lookup = promisify(createDns(null).lookup) as (
      name: string,
      options?: object,
    ) => Promise<unknown>;
    expect(await lookup('localhost')).toEqual({ address: '127.0.0.1', family: 4 });
    expect(await lookup('localhost', { all: true })).toEqual([{ address: '127.0.0.1', family: 4 }]);
  });
});
