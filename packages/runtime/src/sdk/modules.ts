// The packages' surface: helpers for a page program that works on the
// project's files as a tool does (the esbuild and tailwind packages'):
// POSIX paths, synchronous reads over the files' async API, directories
// made as needed, and a CommonJS module's evaluation. Code, not a
// protocol: a package bundles its own copy.
export { Fault, SyncFiles, evaluate, made, path, withFaults } from '../programs/modules';
