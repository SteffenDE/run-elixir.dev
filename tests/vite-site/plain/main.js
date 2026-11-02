// A page that runs a project with create(), its packages where another
// origin serves them (CONTENT, the shared usercontent domain beside it) and
// the api's apex worker where its bundler put it: no usercontent.worker.
import { create } from '@elixir-playground/api';
import otp from '@elixir-playground/otp-29.1.2';
import elixir from '@elixir-playground/elixir';
import shell from '@elixir-playground/shell';

const { content, usercontent, runtime } = Object.fromEntries(new URLSearchParams(location.search));

window.result = (async () => {
  const sandbox = await create({
    plugins: [otp, elixir, shell],
    project: { template: 'empty' },
    usercontent: { domain: usercontent, content },
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
