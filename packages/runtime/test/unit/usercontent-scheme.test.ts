// The usercontent origins' scheme (site.ts domainScheme, docs/frames.md
// "Schemes"): the one a domain is written with, else https, but http for a
// local domain; never the page's. A page on http://localhost:9000 frames
// the shared domain's https origins.
import { afterEach, describe, expect, it, vi } from 'vitest';

const site = () => import('../../src/lib/site');
const api = () => import('../../../api/src/usercontent');
const frames = () => import('../../../api/src/sharedFrame');

const SHARED = 'run-elixir-usercontent.org';
const KEY = 'abcdefghij';

function on(page: string, config: Record<string, string> = {}) {
  vi.stubGlobal('location', new URL(page));
  vi.stubGlobal('document', { querySelector: () => null, readyState: 'complete' });
  vi.stubGlobal('localStorage', { getItem: () => 'salt', setItem: () => {} });
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(config)));
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe.each(['http://localhost:9000/', 'https://tidewave.example/'])('a page on %s', (page) => {
  it('names https origins on a shared domain', async () => {
    on(page);
    const { execOrigin, previewOrigin, previewOrigins } = await site();
    expect(execOrigin(KEY, SHARED)).toBe(`https://e-${KEY}.${SHARED}`);
    expect(previewOrigin(KEY, 4000, SHARED)).toBe(`https://v-${KEY}-4000.${SHARED}`);
    expect(previewOrigins(KEY, SHARED)).toBe(`https://v-${KEY}-{port}.${SHARED}`);
  });

  it('names http origins on a *.localhost:PORT domain', async () => {
    on(page);
    const { execOrigin, previewOrigin } = await site();
    expect(execOrigin(KEY, 'bridge.localhost:8081')).toBe(`http://e-${KEY}.bridge.localhost:8081`);
    expect(previewOrigin(KEY, 4000, 'bridge.localhost:8081')).toBe(
      `http://v-${KEY}-4000.bridge.localhost:8081`,
    );
    // A *.localhost domain without a port, and another with one.
    expect(execOrigin(KEY, 'usercontent.localhost')).toBe(`http://e-${KEY}.usercontent.localhost`);
    expect(execOrigin(KEY, 'usercontent.test:8443')).toBe(`http://e-${KEY}.usercontent.test:8443`);
  });

  it('keeps the scheme a domain is written with', async () => {
    on(page);
    const { execOrigin, previewOrigin } = await site();
    expect(execOrigin(KEY, 'https://bridge.localhost:8443')).toBe(
      `https://e-${KEY}.bridge.localhost:8443`,
    );
    expect(previewOrigin(KEY, 4000, 'http://usercontent.example/')).toBe(
      `http://v-${KEY}-4000.usercontent.example`,
    );
    expect(() => execOrigin(KEY, 'ftp://usercontent.example')).toThrow(/http or https/);
  });

  it("names the claude frame's origin by the same rule", async () => {
    on(page);
    const { frameOrigin } = await frames();
    for (const [domain, scheme] of [
      [`https://${SHARED}`, 'https:'],
      ['http://bridge.localhost:8081', 'http:'],
    ]) {
      const bridge = { domain } as Parameters<typeof frameOrigin>[0];
      const origin = await frameOrigin(bridge, '@elixir-playground/claude', 'claude');
      expect(new URL(origin).protocol).toBe(scheme);
      expect(origin).toMatch(new RegExp(`//claude-[a-z0-9]{10}\\.${new URL(domain).host}$`));
    }
  });

  it("create()'s usercontent takes its scheme from the domain, or `scheme`", async () => {
    on(page);
    const { usercontentOf } = await api();
    expect((await usercontentOf(SHARED)).domain).toBe(`https://${SHARED}`);
    expect((await usercontentOf(undefined)).domain).toBe(`https://${SHARED}`);
    expect((await usercontentOf('bridge.localhost:8081')).domain).toBe(
      'http://bridge.localhost:8081',
    );
    expect((await usercontentOf({ domain: 'bridge.localhost:8443', scheme: 'https' })).domain).toBe(
      'https://bridge.localhost:8443',
    );
    expect((await usercontentOf({ domain: `https://${SHARED}`, scheme: 'http' })).domain).toBe(
      `http://${SHARED}`,
    );
  });
});

describe('a usercontent frame of an apex of another scheme', () => {
  it('names the apex with its own scheme', async () => {
    // An https exec frame bridged by http://localhost:9000 (usercontent.ts
    // useBridge's config).
    on(`https://e-${KEY}.${SHARED}/`, {
      domain: 'http://localhost:9000',
      usercontent: `https://${SHARED}`,
    });
    const { loadSite, apexOrigin, parentOrigins, siteDomain, execOrigin } = await site();
    await loadSite();
    expect(siteDomain()).toBe('localhost:9000');
    expect(apexOrigin()).toBe('http://localhost:9000');
    expect(parentOrigins()).toEqual(['http://localhost:9000']);
    expect(execOrigin(KEY)).toBe(`https://e-${KEY}.${SHARED}`);
  });

  it('knows a preview origin below a domain written with its scheme', async () => {
    on(`https://v-${KEY}-4000.${SHARED}/`, {
      domain: 'https://apex.example',
      usercontent: `https://${SHARED}`,
    });
    const { loadSite, previewSite, strayOrigin } = await site();
    await loadSite();
    expect(previewSite()).toEqual({ project: KEY, port: 4000 });
    expect(strayOrigin()).toBe(false);
  });
});

describe("the apex's own pages", () => {
  it("keep the page's scheme for its own host", async () => {
    on('https://playground.example:8443/', { domain: 'playground.example:8443' });
    const { loadSite, apexUrl } = await site();
    await loadSite();
    expect(apexUrl('/x/')).toBe('https://playground.example:8443/x/');
  });
});

describe("the packages' bases", () => {
  const descriptor = {
    name: '@elixir-playground/otp',
    version: '1.0.0',
    base: '/npm/otp/',
    files: {},
  };
  const bases = async (page: string, domain: string) => {
    on(page, { name: '@elixir-playground/runtime', version: '2.0.0' });
    const { useBridge } = await api();
    const { packages, boot } = await useBridge(
      { domain },
      '/npm/runtime/',
      [descriptor] as never,
      { base: '/boot/' } as never,
      null,
    );
    return [packages[0].base, boot!.base];
  };

  it('are where the page serves them, but below the bridge for http files in https frames', async () => {
    expect(await bases('https://tidewave.example/', `https://${SHARED}`)).toEqual([
      'https://tidewave.example/npm/otp/',
      'https://tidewave.example/boot/',
    ]);
    expect(await bases('http://localhost:9000/', 'http://bridge.localhost:8081')).toEqual([
      'http://localhost:9000/npm/otp/',
      'http://localhost:9000/boot/',
    ]);
    // WebKit blocks an http read from an https frame (mixed content).
    expect(await bases('http://localhost:9000/', `https://${SHARED}`)).toEqual([
      'npm/@elixir-playground/otp@1.0.0/',
      'boot/',
    ]);
  });
});
