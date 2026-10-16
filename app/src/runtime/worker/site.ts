// A path in the build this worker came from (b/ID/, build.py), or on the
// site for an absolute one. Through a variable: Vite takes
// new URL('…', import.meta.url) with the path written out for an asset of
// the bundle. Only the worker's entry imports this: in a chunk of its own,
// import.meta.url would name the chunk.
export const site = (path: string) => new URL(path, import.meta.url);
