// A page of a site that runs a project with create(): the packages as
// installed, its usercontent domain the plugin's (vite.config.js).
import { create } from '@elixir-playground/api';
import otp from '@elixir-playground/otp-29.1.2';
import elixir from '@elixir-playground/elixir-1.20.4';
import standard from '@elixir-playground/standard';

window.result = (async () => {
  const sandbox = await create({ plugins: [otp, elixir, standard], project: { template: 'empty' } });
  const p = sandbox.sh('elixir -e "IO.puts(6 * 7)" && echo $PWD');
  let out = '';
  p.onStdout((bytes) => (out += new TextDecoder().decode(bytes)));
  p.onStderr((bytes) => (out += new TextDecoder().decode(bytes)));
  const exit = await p.exited;
  document.getElementById('out').textContent = out;
  return { out, exit, runtime: sandbox.runtime };
})().catch((error) => ({ error: `${error.code}: ${error.message}` }));
