// A package's NIF library built to WebAssembly, for make (programs.ts):
// the backend's, which the apex's worker asks (lib/apexLink.ts: the
// backend sees the apex's Origin).
import { serviceUrl, siteGetSync as get } from '../lib/apexLink';
import type { Channel } from './channel';
import { artifacts } from './site';

// The backend's answer's own URL (/api/v1/nif/NAME/VERSION/library.tar)
// as the service's.
const nifUrl = (path: string) => serviceUrl(`nif/${path.replace(/^.*\/api\/v1\/nif\//, '')}`);

// A tar (ustar), and not the page a site answers a path it lacks with.
const isTar = (bytes: Uint8Array | null): bytes is Uint8Array =>
  (bytes?.length as number) > 262 &&
  new TextDecoder().decode(bytes!.subarray(257, 262)) === 'ustar';

// What a backend build's status means, for the terminal.
const NIF_STATUS: Record<string, string> = {
  queued: 'waiting for a build machine',
  running: 'building in a VM',
  setting_up: 'no recipe builds it yet: an agent is working one out (this can take minutes)',
};

// The backend's build of a package's NIF library: asks until it is built
// or failed, every 2 s, telling the terminal (say) and the page (a 'nif'
// message: { name, version, status, error }) when its status changes.
// Ctrl-C stops waiting (the node stops as it would). A tar, or why not.
export function backendNif(
  channel: Channel,
  name: string,
  version: string,
  report: (text: string) => void,
): Uint8Array | string | null {
  // The NIF ABI the site's OTP loads (docs/nif.md): the backend builds for
  // one, and refuses a request for another.
  const abi = artifacts().find('nifAbi')?.value ?? '';
  const api = nifUrl(
    `${encodeURIComponent(name)}/${encodeURIComponent(version)}?abi=${encodeURIComponent(abi)}`,
  );
  const tell = (status: string | undefined, error: string | null = null) =>
    postMessage({ kind: 'nif', name, version, status, error });
  let last: string | null | undefined = null;
  for (;;) {
    const [code, body] = get(api, false);
    let answer: { url?: string; error?: string; status?: string } | null = null;
    try {
      answer = JSON.parse(body as string);
    } catch {}
    if (code === 200 && answer?.url) {
      const [status, tar] = get(nifUrl(answer.url));
      if (status === 200 && isTar(tar)) {
        if (last) report(`${name} ${version} is built`);
        tell('succeeded');
        return tar;
      }
      tell('failed', `the library did not download (${status})`);
      return `the playground's build of ${name} ${version} did not download (${status})`;
    }
    if (code !== 202) {
      const error =
        answer?.error ??
        (code
          ? `the playground's backend answered ${code}`
          : "the playground's backend could not be reached");
      // A site without a backend answers its page: no build, as before.
      if (code === 200 || (code === 404 && !answer)) return null;
      tell(answer?.status ?? 'failed', error);
      return `${name} ${version} could not be built for the playground: ${error}`;
    }
    if (answer?.status !== last) {
      last = answer?.status;
      report(`${name} ${version}: ${NIF_STATUS[last as string] ?? last}…`);
      tell(last);
    }
    for (let waited = 0; waited < 2000; waited += 200) {
      channel.sleep(200);
      channel.pump();
      if (channel.interrupted) {
        tell('interrupted');
        return `stopped waiting for ${name} ${version}'s build`;
      }
    }
  }
}
