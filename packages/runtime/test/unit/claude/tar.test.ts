import { expect, test, vi } from 'vitest';
import { untarOne } from '../../../src/programs/claude/build';

vi.mock('../../../src/programs/esbuild', () => ({ load: vi.fn() }));

test('extracts a file when padding arrives in separate chunks', async () => {
  const header = new Uint8Array(512);
  header.set(new TextEncoder().encode('package/claude'));
  header.set(new TextEncoder().encode('00000000003\0'), 124);
  header[156] = 48;
  const chunks = [header, Uint8Array.of(97, 98, 99, 0), new Uint8Array(508), new Uint8Array(1024)];
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
  expect(new TextDecoder().decode((await untarOne(stream.getReader(), 'package/claude'))!)).toBe(
    'abc',
  );
});
