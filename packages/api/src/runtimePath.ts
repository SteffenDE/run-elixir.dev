// The runtime package's path on the usercontent domain
// (/npm/@elixir-playground/runtime@VERSION/: the workers, the frames'
// pages): create()'s `runtime`, by default what the page's
// <meta name="playground-runtime"> names (runtime/build.py names it in
// the playground's pages; immutable, so a page loaded before a deploy
// keeps its own build's runtime).
let runtime =
  document.querySelector<HTMLMetaElement>('meta[name="playground-runtime"]')?.content ?? '/';

export const runtimePath = () => runtime;
export function setRuntimePath(path: string): void {
  runtime = path.endsWith('/') ? path : `${path}/`;
}
