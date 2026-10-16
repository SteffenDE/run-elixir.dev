// Hex for the nodes: Hex fetches from a port the page serves (HEX_MIRROR,
// HEX_API_URL), and the page fetches for it (src/runtime/fetcher.ts). Hex
// checks the registry's signature and each tarball's checksum itself, so
// whatever serves the repository can delay or fail, not alter.
//
// - The repository (repo.hex.pm sends no CORS headers): the site's own
//   proxy at /hex/ (serve.py, Caddy: docs/deploy.md), else a public mirror
//   that sends CORS headers.
// - The API (hex.pm sends CORS headers): directly.
import { fetcher } from '@/runtime/fetcher';

export const HEX_PORT = 49180;
const MIRROR = 'https://hexpm.upyun.com';
const API = 'https://hex.pm/api';

export const hexEnv = {
  HEX_MIRROR: `http://localhost:${HEX_PORT}/repo`,
  HEX_API_URL: `http://localhost:${HEX_PORT}/api`,
};

// The site's proxy, if it has one (a site without one answers its page,
// HTML, for /hex/).
let repository: Promise<string> | null = null;
function repositoryBase(): Promise<string> {
  repository ??= fetch('/hex/public_key', { method: 'HEAD' }).then(
    (response) =>
      response.ok && !response.headers.get('content-type')?.startsWith('text/html')
        ? `${location.origin}/hex`
        : MIRROR,
    () => MIRROR,
  );
  return repository;
}

export const hex = fetcher({
  cache: 'playground-hex',
  // Tarballs never change; the registry does, hourly.
  keep: (url: string) => url.includes('/tarballs/'),
  async route(path: string) {
    // A repository's files only (not Hex's own installs, which its update
    // check asks for).
    if (/^\/repo\/(names|versions|public_key|(packages|tarballs)\/[^/]+)$/.test(path.split('?')[0]))
      return `${await repositoryBase()}${path.slice('/repo'.length)}`;
    if (path.startsWith('/api/')) return `${API}${path.slice('/api'.length)}`;
    return null;
  },
});
