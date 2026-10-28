import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';

const html = readFileSync(new URL('../../public/relay.html', import.meta.url), 'utf8');
const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)![1];
const run = new Function('navigator', 'location', `return (async () => {${source}})();`);
const runtime = '/npm/@elixir-playground/runtime@1.0.0+abcdef/';

it('waits for the replacement worker to activate before navigating to the package relay', async () => {
  const worker = Object.assign(new EventTarget(), { state: 'installing' });
  const registration = { update: vi.fn(async () => {}), installing: worker };
  const serviceWorker = { register: vi.fn(async () => registration) };
  const location = {
    href: `https://preview.test/relay.html?runtime=${encodeURIComponent(runtime)}`,
    replace: vi.fn(),
  };
  const loading = run({ serviceWorker }, location);
  await vi.waitFor(() => expect(registration.update).toHaveBeenCalled());
  expect(location.replace).not.toHaveBeenCalled();
  worker.state = 'activated';
  worker.dispatchEvent(new Event('statechange'));
  await loading;
  expect(serviceWorker.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  expect(location.replace).toHaveBeenCalledWith(`${runtime}relay.html`);
});

it('navigates when the current worker is already up to date', async () => {
  const serviceWorker = {
    register: async () => ({ update: async () => {}, active: { state: 'activated' } }),
  };
  const location = {
    href: `https://preview.test/relay.html?runtime=${encodeURIComponent(runtime)}`,
    replace: vi.fn(),
  };
  await run({ serviceWorker }, location);
  expect(location.replace).toHaveBeenCalledWith(`${runtime}relay.html`);
});

it('does not navigate if the replacement fails to install', async () => {
  const worker = Object.assign(new EventTarget(), { state: 'installing' });
  const serviceWorker = {
    register: async () => ({ update: async () => {}, installing: worker }),
  };
  const location = {
    href: `https://preview.test/relay.html?runtime=${encodeURIComponent(runtime)}`,
    replace: vi.fn(),
  };
  const loading = run({ serviceWorker }, location);
  const rejected = expect(loading).rejects.toThrow('service worker update failed');
  await new Promise((resolve) => setTimeout(resolve, 0));
  worker.state = 'redundant';
  worker.dispatchEvent(new Event('statechange'));
  await rejected;
  expect(location.replace).not.toHaveBeenCalled();
});
