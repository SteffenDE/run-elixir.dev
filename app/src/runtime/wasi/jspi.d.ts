// JSPI, which TypeScript's DOM library does not have yet: an import that
// may answer with a promise, suspending the instance until it settles, and
// an export run on a stack of its own that such an import may suspend.
declare namespace WebAssembly {
  // oxlint-disable-next-line typescript/no-extraneous-class -- JSPI's wrapper for an import.
  class Suspending {
    constructor(f: (...args: never[]) => unknown);
  }
  function promising<A extends unknown[], R>(f: (...args: A) => R): (...args: A) => Promise<R>;
}
