import { describe, expect, it } from 'vitest';
import { withLayer } from '../../src/packages/layer';
import type { FsLayer, PackageEntry } from '../../src/packages/types';

const prepared: FsLayer = {
  format: 3,
  root: '/opt/elixir/1.20.4',
  manifest: 'fs/manifest.json',
  bundles: 'fs/bundles/',
  count: 4,
  version: 'abc',
};

const entry = (playground: PackageEntry['playground']): PackageEntry => ({
  version: '3.0.0',
  base: '/npm/@elixir-playground/elixir@3.0.0/',
  files: {},
  playground,
});

describe('withLayer', () => {
  it('reads a layer into fs, its paths below the package', async () => {
    const asked: string[] = [];
    const read = await withLayer(
      entry({ elixir: '1.20.4', layer: 'versions/1.20.4-otp-29/fs.json' }),
      async (path) => (asked.push(path), prepared),
    );
    expect(asked).toEqual(['versions/1.20.4-otp-29/fs.json']);
    expect(read.playground).toEqual({
      elixir: '1.20.4',
      fs: {
        ...prepared,
        manifest: 'versions/1.20.4-otp-29/fs/manifest.json',
        bundles: 'versions/1.20.4-otp-29/fs/bundles/',
      },
    });
  });

  it('leaves a package without one, or with fs, as it is', async () => {
    const load = async (): Promise<FsLayer> => {
      throw new Error('not asked');
    };
    const plain = entry({ bin: { mix: 'bin/mix' } });
    expect(await withLayer(plain, load)).toBe(plain);
    const laid = entry({ fs: prepared, layer: 'versions/x/fs.json' });
    expect(await withLayer(laid, load)).toBe(laid);
  });
});
