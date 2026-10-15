// Where this page's build keeps its runtime, files and WebAssembly:
// /b/ID/, which runtime/build.py names in each page's
// <meta name="playground-build">. A page loaded before a deploy keeps
// loading its own build's files, never a newer one's. Without it (a site
// laid out flat), the root.
const id = document.querySelector<HTMLMetaElement>('meta[name="playground-build"]')?.content;
export const BUILD = id ? `/b/${id}/` : '/';
