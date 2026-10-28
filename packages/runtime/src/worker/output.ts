// A page program or a node cannot wait for room in a pipe, nor stream its
// input (processes.ts): what it writes ahead of its reader, and the input
// it takes whole, are bounded (HOSTED_LIMIT), so an infinite producer
// fails instead of exhausting the browser's memory.
export class OutputLimitError extends Error {
  constructor() {
    super('shell: buffered output exceeded 16 MiB ahead of its reader');
  }
}
