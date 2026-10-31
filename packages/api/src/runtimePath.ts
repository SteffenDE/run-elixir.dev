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

// In bridge mode, the directory the page serves the packages below
// (usercontent.content's default): what the page's
// <meta name="playground-content"> names (the Vite plugin names its
// `base`), else the page's origin root.
// The shared usercontent domain the page's <meta name="playground-usercontent">
// names (the Vite plugin's `usercontent`), or null.
export const usercontentMeta = () =>
  document.querySelector<HTMLMetaElement>('meta[name="playground-usercontent"]')?.content || null;

export const contentPath = () =>
  document.querySelector<HTMLMetaElement>('meta[name="playground-content"]')?.content ?? '/';
