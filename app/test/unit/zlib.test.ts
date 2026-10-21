import * as node from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { createZlib } from '@/runtime/nodejs/zlib';

const zlib = createZlib();

// What `f` throws: its code and message.
function thrown(f: () => unknown) {
  try {
    f();
  } catch (error) {
    return `${(error as { code: string }).code} ${(error as Error).message}`;
  }
  return 'nothing';
}

describe('a stream', () => {
  test('flush gives what is written so far, then calls back', async () => {
    for (const kind of [[], [node.constants.Z_SYNC_FLUSH]]) {
      const gzip = zlib.createGzip();
      gzip.write('abc');
      const out = await new Promise<Buffer>((resolve) =>
        (gzip.flush as (...a: unknown[]) => void)(...kind, () => resolve(gzip.read())),
      );
      const inflated = node.inflateRawSync(out.subarray(10), {
        finishFlush: node.constants.Z_SYNC_FLUSH,
      });
      expect(inflated.toString()).toBe('abc');
    }
  });
});

test('a stream is made by its class too', () => {
  const gzip = new zlib.Gzip();
  expect(gzip).toBeInstanceOf(zlib.Gzip);
  expect(zlib.createGunzip()).toBeInstanceOf(zlib.Gunzip);
  expect(zlib.createGunzip()).not.toBeInstanceOf(zlib.Gzip);
  expect(gzip.constructor.name).toBe('Gzip');
});

describe('a truncated input', () => {
  const ended = 'Z_BUF_ERROR unexpected end of file';
  const gzipped = node.gzipSync('hello world hello world');
  const deflated = node.deflateSync('hello world hello world');
  const raw = node.deflateRawSync('hello world hello world');

  test('is an unexpected end of file', () => {
    for (const at of [0, 5, 20, gzipped.length - 4])
      expect(thrown(() => zlib.gunzipSync(gzipped.subarray(0, at)))).toBe(ended);
    for (const at of [0, 1, 5, deflated.length - 2])
      expect(thrown(() => zlib.inflateSync(deflated.subarray(0, at)))).toBe(ended);
    expect(thrown(() => zlib.inflateRawSync(raw.subarray(0, 5)))).toBe(ended);
  });

  test("is a stream's unexpected end of file", async () => {
    for (const at of [5, 20]) {
      const gunzip = zlib.createGunzip();
      gunzip.resume();
      const error = await new Promise<Error & { code: string }>((resolve) => {
        gunzip.on('error', resolve);
        gunzip.end(gzipped.subarray(0, at));
      });
      expect(`${error.code} ${error.message}`).toBe(ended);
    }
  });
});

describe('gunzip', () => {
  const two = Buffer.concat([node.gzipSync('hello '), node.gzipSync('world')]);

  test('reads each of concatenated members', async () => {
    expect(zlib.gunzipSync(two).toString()).toBe('hello world');
    expect(zlib.unzipSync(two).toString()).toBe('hello world');
    const result = await new Promise((resolve) =>
      zlib.gunzip(two, (_error, out) => resolve(out?.toString())),
    );
    expect(result).toBe('hello world');
    const streamed = await new Promise((resolve, reject) => {
      const gunzip = zlib.createGunzip();
      const chunks: Buffer[] = [];
      gunzip.on('data', (chunk: Buffer) => chunks.push(chunk));
      gunzip.on('end', () => resolve(Buffer.concat(chunks).toString()));
      gunzip.on('error', reject);
      gunzip.write(two.subarray(0, 30));
      gunzip.end(two.subarray(30));
    });
    expect(streamed).toBe('hello world');
  });

  test('ignores what follows a zero byte, not other bytes', () => {
    expect(zlib.gunzipSync(Buffer.concat([two, Buffer.alloc(4)])).toString()).toBe('hello world');
    expect(thrown(() => zlib.gunzipSync(Buffer.concat([two, Buffer.from('garbage')])))).toBe(
      'Z_DATA_ERROR incorrect header check',
    );
  });
});
