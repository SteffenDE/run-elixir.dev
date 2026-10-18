// A path in the build this worker came from (b/ID/, build.py), or on the
// site for an absolute one. Through a variable: Vite takes
// new URL('…', import.meta.url) with the path written out for an asset of
// the bundle. Only the worker's entry imports this: in a chunk of its own,
// import.meta.url would name the chunk.
export const site = (path: string) => new URL(path, import.meta.url);

// Where the BEAM, the files and the NIF libraries are (the page's
// RUNTIME, build.ts), which the page names as the node starts; until then
// the build's.
let base: URL = site('./');
export const runtime = (path: string) => new URL(path, base);
export function setRuntime(url: string): void {
  base = new URL(url);
}
