// The packages' surface: the runtime's WASI implementation as a library
// (a worker program that runs WebAssembly, such as Node's node:wasi), an
// in-memory tree, tar and gzip, and the errno values. Code, not a
// protocol: a package bundles its own copy.
export { Exit, WASI } from '../wasi/index';
export { Dir, entries, gunzip } from '../wasi/fs';
export { E } from '../wasi/abi';
