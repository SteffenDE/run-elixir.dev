// The test embedder (test/embedder/index.html, serve.py --embedder-host),
// for api.spec.ts and bridge.spec.ts: a page of another site that imports
// the api package and its plugins as installed, and drives sandboxes
// through window.embed and window.sandbox.
import { readdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { PORT } from './helpers';

export const EMBEDDER = `http://embedder.localhost:${PORT}/`;

// The site's packages' versions, by short name, as build.py laid them out
// (NAME@VERSION+ID), which serve.py serves at their published paths.
export function laidVersions(): Record<string, string> {
  const top = new URL('../../../target/site/npm/@elixir-playground/', import.meta.url);
  return Object.fromEntries(
    readdirSync(top).map((entry) => {
      const [name, version] = entry.split('+')[0].split('@');
      return [name, version];
    }),
  );
}

declare global {
  interface Window {
    // oxlint-disable-next-line typescript/no-explicit-any -- the page's test hooks.
    embed: any;
    // oxlint-disable-next-line typescript/no-explicit-any
    sandbox: any;
  }
}

// The embedder's page, and a sandbox of `project` in it (window.sandbox):
// template 'phoenix' is the embedder's template package; how long
// create() took. `extra.bridged`: in bridge mode.
export async function embedded(
  page: Page,
  project: object = { template: 'phoenix' },
  extra: { bridged?: boolean } & Record<string, unknown> = {},
): Promise<number> {
  await page.goto(EMBEDDER);
  await page.waitForFunction(() => window.embed);
  return page.evaluate(
    async (given) => {
      const source =
        (given.project as { template?: string }).template === 'phoenix'
          ? { ...given.project, template: await window.embed.template }
          : given.project;
      const { bridged, ...options } = given.extra;
      const started = performance.now();
      window.sandbox = await window.embed.create({
        ...(bridged ? window.embed.bridged() : window.embed.options),
        project: source,
        container: document.getElementById('frames'),
        onProgress: (event: unknown) => window.embed.progress.push(event),
        ...options,
      });
      return performance.now() - started;
    },
    { project, extra },
  );
}

// A command's stdout, stderr and exit code, run without a tty: a shell
// line (sh) or its words (spawn).
export function run(page: Page, command: string | string[], options: object = {}) {
  return page.evaluate(
    async (given) => {
      const process =
        typeof given.command === 'string'
          ? window.sandbox.sh(given.command, given.options)
          : window.sandbox.spawn(given.command, given.options);
      const out: Uint8Array[] = [];
      const err: Uint8Array[] = [];
      process.onStdout((bytes: Uint8Array) => out.push(bytes));
      process.onStderr((bytes: Uint8Array) => err.push(bytes));
      const { code } = await process.exited;
      const text = (parts: Uint8Array[]) =>
        parts.map((part) => new TextDecoder().decode(part)).join('');
      return { stdout: text(out), stderr: text(err), code };
    },
    { command, options },
  );
}

// A raw HTTP/1.1 GET over connect(port): the response's text.
export function get(page: Page, port: number, path: string, headers = '') {
  return page.evaluate(
    async ({ to, at, more }) => {
      const stream = await window.sandbox.connect(to);
      const parts: Uint8Array[] = [];
      const done = new Promise<void>((resolve) => {
        stream.onData((bytes: Uint8Array) => parts.push(bytes));
        stream.onEnd(resolve);
        stream.onClose(resolve);
      });
      stream.write(
        `GET ${at} HTTP/1.1\r\nhost: localhost:${to}\r\n${more}connection: close\r\n\r\n`,
      );
      await done;
      return parts.map((part) => new TextDecoder().decode(part)).join('');
    },
    { to: port, at: path, more: headers },
  );
}

// The text of the preview the embedder frames (#preview), as it answers.
export function previewText(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const frame = document.getElementById('preview') as HTMLIFrameElement | null;
        if (!frame?.contentWindow) return resolve('');
        const id = Math.random();
        const heard = (event: MessageEvent) => {
          if (event.data?.kind !== 'playground-snapshot' || event.data.id !== id) return;
          removeEventListener('message', heard);
          resolve(event.data.text);
        };
        addEventListener('message', heard);
        frame.contentWindow.postMessage({ kind: 'playground-snapshot', id }, '*');
        setTimeout(() => resolve(''), 2000);
      }),
  );
}
