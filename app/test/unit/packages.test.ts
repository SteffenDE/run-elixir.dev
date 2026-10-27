import { describe, expect, it } from 'vitest';
import { HOST, assertSite, checkSite, type Host } from '@/runtime/packages/check';
import { Site, type SiteManifest } from '@/runtime/packages/manifest';

const RUNTIME = '@elixir-playground/runtime';
const OTP = '@elixir-playground/otp-29.1.2';
const ELIXIR = '@elixir-playground/elixir-1.20.4';
const TEMPLATE = '@elixir-playground/phoenix-template';
const file = { size: 1, sha256: '00' };

// A site as runtime/build.py writes it, in a layout of npm's: each package
// under its own name and version.
function site(): SiteManifest {
  return {
    manifest: 1,
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
          beam: { loader: 'beam.mjs', threads: 'beam.emu.mjs', wasm: 'beam.wasm' },
        },
      },
      [ELIXIR]: {
        version: '1.0.3',
        base: '../elixir-1.20.4@1.0.3/',
        files: {},
        peerDependencies: { [RUNTIME]: '^1.0.0' },
        playground: { elixir: '1.20.4', requires: { otp: '^29.0.0' } },
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
          tools: 'coreutils.wasm',
          programs: { ls: 'coreutils.wasm', cat: 'coreutils.wasm' },
        },
      },
      '@elixir-playground/git': {
        version: '1.1.0',
        base: '../git@1.1.0/',
        files: { 'git.wasm': file },
        peerDependencies: { [RUNTIME]: '^1.0.0' },
        playground: { abi: { wasi: 1, processes: 1 }, programs: { git: 'git.wasm' } },
      },
      '@elixir-playground/tls': {
        version: '1.0.0',
        base: '../tls@1.0.0/',
        files: { 'tls.wasm': file, 'roots.pem': file },
        peerDependencies: { [RUNTIME]: '^1.0.0' },
        playground: { abi: { wasi: 1, tls: 1 }, tls: { module: 'tls.wasm', roots: 'roots.pem' } },
      },
    },
    fs: {
      base: '../boot@1/',
      format: 1,
      version: 'v1',
      boots: ['boot', 'boot-phoenix'],
      packages: { [OTP]: '1.2.0', [ELIXIR]: '1.0.3', [TEMPLATE]: '1.0.0' },
    },
    nif: { base: '../nif/', nifAbi: '1-2.18', libraries: ['bcrypt_elixir-3.3.2'] },
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
    expect(packages.fs('bundles/3.tar').href).toBe(
      'https://u.test/npm/@elixir-playground/boot@1/bundles/3.tar',
    );
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
    expect(programs.get('ls')).toMatchObject({ tool: true });
    expect(programs.get('git')).toMatchObject({ tool: false });
    expect(programs.get('git')!.url.pathname).toBe('/npm/@elixir-playground/git@1.1.0/git.wasm');
  });

  it('names only the NIF libraries it bundles', () => {
    expect(at().nif('bcrypt_elixir', '3.3.2')!.pathname).toBe(
      '/npm/@elixir-playground/nif/bcrypt_elixir-3.3.2.tar',
    );
    expect(at().nif('bcrypt_elixir', '3.3.1')).toBeNull();
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
    delete manifest.fs!.packages[ELIXIR];
    expect(checkSite(manifest)).toEqual([`${TEMPLATE}@1.0.0 needs ${ELIXIR} ^1, which is missing`]);
    const other = site();
    other.packages[OTP].version = '2.0.0';
    other.fs!.packages[OTP] = '2.0.0';
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

  it('refuses an fs image recorded with other packages', () => {
    const manifest = site();
    manifest.packages[OTP].version = '1.2.1';
    expect(checkSite(manifest)).toEqual([`the fs image was made with ${OTP}@1.2.0, not 1.2.1`]);
    const format = site();
    format.fs!.format = 2;
    expect(checkSite(format)).toEqual(['the fs image is format 2; this runtime reads 1']);
  });

  it('refuses NIF libraries of another NIF ABI, not of another BEAM build', () => {
    const manifest = site();
    manifest.nif!.nifAbi = '1-2.17';
    expect(checkSite(manifest)).toEqual(['the NIF libraries are for NIF ABI 1-2.17, not 1-2.18']);
    const rebuilt = site();
    rebuilt.packages[OTP].playground.beamAbi = 'b2';
    expect(checkSite(rebuilt)).toEqual([]);
  });

  it('refuses an OTP whose NIF layer this runtime does not load', () => {
    const manifest = site();
    manifest.packages[OTP].playground.nifAbi = '2-2.18';
    manifest.nif!.nifAbi = '2-2.18';
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
    expect(checkSite({ ...site(), manifest: 2 })).toEqual([
      'site.json is manifest 2; this runtime reads 1',
    ]);
  });

  it('fails with ERUNTIME', () => {
    const manifest = site();
    manifest.nif!.nifAbi = '1-2.17';
    expect(() => assertSite(manifest)).toThrow(
      expect.objectContaining({ code: 'ERUNTIME', message: expect.stringContaining('1-2.17') }),
    );
  });
});
