// A page whose packages all come from a public npm CDN (../cdn.sh): their
// descriptors imported from it, their files below `content` (jsDelivr's
// /npm/ layout as the descriptors' bases name it, or unpkg's by
// packagePath), the runtime there too. Only the api is the page's own.
import { create } from '@elixir-playground/api';

const query = Object.fromEntries(new URLSearchParams(location.search));
const { content, usercontent, runtime, packagePath } = query;
const descriptors = query.packages.split(',');

window.result = (async () => {
  const plugins = await Promise.all(
    descriptors.map(async (url) => (await import(/* @vite-ignore */ url)).default),
  );
  const sandbox = await create({
    plugins,
    project: { template: 'empty' },
    usercontent: { domain: usercontent, content, ...(packagePath ? { packagePath } : {}) },
    runtime,
    services: { relay: null, nif: null, git: null },
  });
  const p = sandbox.sh('elixir -e "IO.puts(6 * 7)" && echo $PWD');
  let out = '';
  p.onStdout((bytes) => (out += new TextDecoder().decode(bytes)));
  p.onStderr((bytes) => (out += new TextDecoder().decode(bytes)));
  const exit = await p.exited;
  document.getElementById('out').textContent = out;
  return { out, exit, runtime: sandbox.runtime };
})().catch((error) => ({ error: `${error.code}: ${error.message}` }));
