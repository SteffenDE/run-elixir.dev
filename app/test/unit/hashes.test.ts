import * as crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { expect, test } from 'vitest';
import { hashes } from '../../src/runtime/nodejs/hashes';

test('a hash is a stream: piped into, its digest read', async () => {
  const hash = hashes.createHash('sha256');
  hash.setEncoding('hex');
  const digest = await new Promise((resolve) => {
    hash.on('data', resolve);
    Readable.from(['a', 'b']).pipe(hash as never);
  });
  expect(digest).toBe(crypto.createHash('sha256').update('ab').digest('hex'));
  let piped = '';
  await (pipeline as (...streams: unknown[]) => Promise<void>)(
    Readable.from(['a', 'b']),
    hashes.createHmac('md5', 'k') as never,
    async (source: AsyncIterable<Buffer>) => {
      for await (const chunk of source) piped += chunk.toString('hex');
    },
  );
  expect(piped).toBe(crypto.createHmac('md5', 'k').update('ab').digest('hex'));
  const ended = hashes.createHash('sha1');
  ended.end('ab');
  await new Promise((resolve) => ended.once('readable', resolve));
  expect(ended.read().toString('hex')).toBe(crypto.createHash('sha1').update('ab').digest('hex'));
});

test("a second digest: a hash's throws, an HMAC's is empty", () => {
  const hash = hashes.createHash('sha256');
  hash.digest();
  expect(() => hash.digest()).toThrow(
    expect.objectContaining({ code: 'ERR_CRYPTO_HASH_FINALIZED' }),
  );
  const hmac = hashes.createHmac('sha256', 'k');
  hmac.digest();
  expect(hmac.digest('hex')).toBe('');
  expect(() => hmac.update('x')).toThrow(
    expect.objectContaining({ code: 'ERR_CRYPTO_HASH_FINALIZED' }),
  );
});
