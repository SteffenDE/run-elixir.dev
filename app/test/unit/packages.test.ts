import { describe, expect, it } from 'vitest';
import { HOST, assertSite, checkSite, type Host } from '@/runtime/packages/check';
import { Site, type SiteManifest } from '@/runtime/packages/manifest';
import type { Manifest } from '@/runtime/wasi/fs';

const RUNTIME = '@elixir-playground/runtime';
const OTP = '@elixir-playground/otp-29.1.2';
const ELIXIR = '@elixir-playground/elixir-1.20.4';
const TEMPLATE = '@elixir-playground/phoenix-template';
const file = { size: 1, sha256: '00' };

// A site as runtime/build.py writes it, in a layout of npm's: each package
// under its own name and version.
// A package's fs layer: `count` bundles.
const layer = (count: number, version: string) => ({
  format: 2,
  manifest: 'fs/manifest.json',
  bundles: 'fs/bundles/',
  count,
  version,
});

function site(): SiteManifest {
  return {
    manifest: 2,
    packages: {
      [OTP]: {
        version: '1.2.0',
        base: '../otp-29.1.2@1.2.0/',
        files: { 'beam.mjs': file, 'beam.emu.mjs': file, 'beam.wasm': file },
        peerDependencies: { [RUNTIME]: '^1.0.0' },
        playground: {
          abi: { beam: 1 },
          otp: '29.1.2',
          beamAbi: 'b1',
          nifAbi: '1-2.18',
          beam: { loader: 'beam.mjs', wasm: 'beam.wasm' },
          fs: layer(3, 'o1'),
        },
      },
      [ELIXIR]: {
        version: '1.0.3',
        base: '../elixir-1.20.4@1.0.3/',
        files: {},
        peerDependencies: { [RUNTIME]: '^1.0.0' },
        playground: { elixir: '1.20.4', requires: { otp: '^29.0.0' }, fs: layer(2, 'e1') },
      },
      [TEMPLATE]: {
        version: '1.0.0',
        base: '../phoenix-template@1.0.0/',
        files: {},
        peerDependencies: { [RUNTIME]: '^1.0.0', [OTP]: '^1', [ELIXIR]: '^1' },
        playground: {
          template: {
            kind: 'phoenix',
            id: 't1',
            label: 'phx.new 1.8.15',
            otp: '29.1.2',
            elixir: '1.20.4',
          },
        },
      },
      '@elixir-playground/shell': {
        version: '1.0.0',
        base: '../shell@1.0.0/',
        files: { 'brush.wasm': file, 'coreutils.wasm': file },
        peerDependencies: { [RUNTIME]: '^1.0.0' },
        playground: {
          abi: { wasi: 1, processes: 1, crossterm: 1 },
          shell: 'brush.wasm',
          programs: {
            ls: { module: 'coreutils.wasm', multicall: true },
            cat: { module: 'coreutils.wasm', multicall: true },
          },
        },
      },
      '@elixir-playground/git': {
        version: '1.1.0',
        base: '../git@1.1.0/',
        files: { 'git.wasm': file },
        peerDependencies: { [RUNTIME]: '^1.0.0' },
        playground: { abi: { wasi: 1, processes: 1 }, programs: { git: { module: 'git.wasm' } } },
      },
      '@elixir-playground/tls': {
        version: '1.0.0',
        base: '../tls@1.0.0/',
        files: { 'tls.wasm': file, 'roots.pem': file },
        peerDependencies: { [RUNTIME]: '^1.0.0' },
        playground: { abi: { wasi: 1, tls: 1 }, tls: { module: 'tls.wasm', roots: 'roots.pem' } },
      },
    },
    boot: {
      base: '../../../boot/b1/',
      images: ['boot', 'boot-phoenix'],
      packages: { [OTP]: '1.2.0', [ELIXIR]: '1.0.3', [TEMPLATE]: '1.0.0' },
    },
  };
}

const at = (manifest = site()) =>
  new Site({ url: 'https://u.test/npm/@elixir-playground/site/site.json', manifest });

describe('the site manifest', () => {
  it('finds each package’s files relative to site.json', () => {
    const packages = at();
    expect(packages.beam()!.loader.href).toBe(
      'https://u.test/npm/@elixir-playground/otp-29.1.2@1.2.0/beam.mjs',
    );
    expect(packages.shell()!.href).toBe(
      'https://u.test/npm/@elixir-playground/shell@1.0.0/brush.wasm',
    );
    expect(packages.boot('boot-phoenix').href).toBe('https://u.test/boot/b1/boot-phoenix.tar.gz');
    expect(packages.boots()).toEqual(['boot', 'boot-phoenix']);
    expect(() => packages.boot('boot-livebook')).toThrow('no boot image boot-livebook');
    expect(packages.tls()).toEqual({
      module: 'https://u.test/npm/@elixir-playground/tls@1.0.0/tls.wasm',
      roots: 'https://u.test/npm/@elixir-playground/tls@1.0.0/roots.pem',
    });
    expect(packages.versions()).toEqual({ otp: '29.1.2', elixir: '1.20.4' });
    expect(packages.template('phoenix')).toEqual({ id: 't1', label: 'phx.new 1.8.15' });
    expect(packages.template('empty')).toBeNull();
  });

  it('registers every package’s programs, the tools’ module apart', () => {
    const programs = at().programs();
    expect([...programs.keys()].sort()).toEqual(['cat', 'git', 'ls']);
    expect(programs.get('ls')).toMatchObject({ multicall: true });
    expect(programs.get('git')).toMatchObject({ multicall: false });
    expect(at().multicall()!.pathname).toBe('/npm/@elixir-playground/shell@1.0.0/coreutils.wasm');
    expect(programs.get('git')!.url.pathname).toBe('/npm/@elixir-playground/git@1.1.0/git.wasm');
  });

  it('numbers the layers’ bundles one after another, and finds each', async () => {
    const packages = at();
    const listed: Record<string, Manifest> = {
      'otp-29.1.2@1.2.0': [
        ['rotp/lib/kernel/ebin/kernel.app', 10, 1, 0],
        ['rotp/lib/stdlib/ebin/lists.beam', 20, 1, 2],
      ],
      'elixir-1.20.4@1.0.3': [['rotp/lib/elixir/ebin/elixir.app', 30, 1, 1]],
    };
    const tree = await packages.tree(async (url) => listed[url.pathname.split('/').at(-3)!] ?? []);
    expect(tree).toEqual([
      ['rotp/lib/kernel/ebin/kernel.app', 10, 1, 0],
      ['rotp/lib/stdlib/ebin/lists.beam', 20, 1, 2],
      ['rotp/lib/elixir/ebin/elixir.app', 30, 1, 4],
    ]);
    expect(packages.bundle(2).pathname).toBe(
      '/npm/@elixir-playground/otp-29.1.2@1.2.0/fs/bundles/2.tar',
    );
    expect(packages.bundle(4).pathname).toBe(
      '/npm/@elixir-playground/elixir-1.20.4@1.0.3/fs/bundles/1.tar',
    );
    expect(() => packages.bundle(5)).toThrow('no bundle 5');
  });

  it('names what kept changes were made over by the layers’ versions', () => {
    const before = at().fsVersion();
    expect(before).toMatch(/^[0-9a-f]{16}$/);
    expect(at().fsVersion()).toBe(before);
    const rebuilt = site();
    rebuilt.packages[ELIXIR].playground.fs!.version = 'e2';
    expect(at(rebuilt).fsVersion()).not.toBe(before);
    // Not the packages' other files.
    const other = site();
    other.packages[OTP].files['beam.wasm'] = { size: 2, sha256: '11' };
    expect(at(other).fsVersion()).toBe(before);
  });

  it('has no BEAM or shell without their packages', () => {
    const manifest = site();
    delete manifest.packages[OTP];
    delete manifest.packages['@elixir-playground/shell'];
    expect(at(manifest).beam()).toBeNull();
    expect(at(manifest).shell()).toBeNull();
    expect(at(manifest).versions()).toBeNull();
  });
});

describe('the load-time check', () => {
  it('passes a site that fits this runtime', () => {
    expect(checkSite(site())).toEqual([]);
    expect(() => assertSite(site())).not.toThrow();
  });

  it('refuses a package for another host ABI (the runtime’s major)', () => {
    const manifest = site();
    manifest.packages['@elixir-playground/git'].peerDependencies![RUNTIME] = '^2.0.0';
    expect(checkSite(manifest)).toEqual([
      `@elixir-playground/git@1.1.0 needs ${RUNTIME} ^2.0.0, not ${HOST.version}`,
    ]);
  });

  it('refuses a package that needs a newer minor of the runtime', () => {
    const host: Host = { ...HOST, version: '1.2.0' };
    const manifest = site();
    manifest.packages['@elixir-playground/git'].peerDependencies![RUNTIME] = '^1.3';
    expect(checkSite(manifest, host)).toHaveLength(1);
    manifest.packages['@elixir-playground/git'].peerDependencies![RUNTIME] = '^1.2';
    expect(checkSite(manifest, host)).toEqual([]);
  });

  it('refuses a seam at a version the runtime does not speak', () => {
    const manifest = site();
    manifest.packages['@elixir-playground/git'].playground.abi!.processes = 2;
    const host: Host = { ...HOST, provides: { ...HOST.provides, processes: [1] } };
    expect(checkSite(manifest, host)).toEqual([
      `@elixir-playground/git@1.1.0 uses the processes ABI 2; ${RUNTIME}@${HOST.version} speaks 1`,
    ]);
    const without: Host = { ...HOST, provides: { ...HOST.provides, tls: [] } };
    expect(checkSite(site(), without)[0]).toMatch(/uses the tls ABI 1; .* has none$/);
  });

  it('refuses a template for another OTP and Elixir pair', () => {
    const manifest = site();
    manifest.packages[TEMPLATE].playground.template!.elixir = '1.20.3';
    expect(checkSite(manifest)).toEqual([
      `${TEMPLATE} was compiled with Elixir 1.20.3, not 1.20.4`,
    ]);
  });

  it('refuses a template whose packages are missing or of another major', () => {
    const manifest = site();
    delete manifest.packages[ELIXIR];
    delete manifest.boot!.packages[ELIXIR];
    expect(checkSite(manifest)).toEqual([`${TEMPLATE}@1.0.0 needs ${ELIXIR} ^1, which is missing`]);
    const other = site();
    other.packages[OTP].version = '2.0.0';
    other.boot!.packages[OTP] = '2.0.0';
    expect(checkSite(other)).toEqual([`${TEMPLATE}@1.0.0 needs ${OTP} ^1, not 2.0.0`]);
  });

  it('refuses an Elixir for another OTP, OTP’s four-part versions too', () => {
    const manifest = site();
    manifest.packages[ELIXIR].playground.requires!.otp = '^30.0.0';
    expect(checkSite(manifest)).toEqual(['Elixir 1.20.4 needs OTP ^30.0.0, not 29.1.2']);
    const patched = site();
    patched.packages[OTP].playground.otp = '29.1.2.1';
    patched.packages[TEMPLATE].playground.template!.otp = '29.1.2.1';
    expect(checkSite(patched)).toEqual([]);
  });

  it('refuses boot images recorded with other packages, and files of another fs format', () => {
    const manifest = site();
    manifest.packages[OTP].version = '1.2.1';
    expect(checkSite(manifest)).toEqual([
      `the boot images were recorded with ${OTP}@1.2.0, not 1.2.1`,
    ]);
    const format = site();
    format.packages[ELIXIR].playground.fs!.format = 1;
    expect(checkSite(format)).toEqual([
      `${ELIXIR}@1.0.3's files are fs format 1; this runtime reads 2`,
    ]);
  });

  it('takes another BEAM build of the same NIF ABI', () => {
    const rebuilt = site();
    rebuilt.packages[OTP].playground.beamAbi = 'b2';
    expect(checkSite(rebuilt)).toEqual([]);
  });

  it('refuses an OTP whose NIF layer this runtime does not load', () => {
    const manifest = site();
    manifest.packages[OTP].playground.nifAbi = '2-2.18';
    expect(checkSite(manifest)).toEqual([
      `OTP's NIF ABI is 2-2.18; ${RUNTIME}@${HOST.version} loads layer 1`,
    ]);
  });

  it('refuses two OTP packages', () => {
    const manifest = site();
    manifest.packages['@elixir-playground/otp-29.1.3'] = {
      ...manifest.packages[OTP],
      playground: { ...manifest.packages[OTP].playground, otp: '29.1.3' },
    };
    expect(checkSite(manifest)).toContain(
      `more than one otp package: ${OTP}, @elixir-playground/otp-29.1.3`,
    );
  });

  it('reads only the manifest versions it knows', () => {
    expect(checkSite({ ...site(), manifest: 1 })).toEqual([
      'site.json is manifest 1; this runtime reads 2',
    ]);
  });

  it('fails with ERUNTIME', () => {
    const manifest = site();
    manifest.packages[OTP].playground.nifAbi = '2-2.18';
    expect(() => assertSite(manifest)).toThrow(
      expect.objectContaining({ code: 'ERUNTIME', message: expect.stringContaining('2-2.18') }),
    );
  });
});
