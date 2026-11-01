// esbuild.js: esbuild-wasm, loaded and started once, for another
// package's code that imports it by URL (the claude package's frame:
// its peer's files below the bridge, docs/packages.md "Page programs and
// shared frames"). Its WebAssembly is beside it, in files/.
export { load } from './esbuild';
