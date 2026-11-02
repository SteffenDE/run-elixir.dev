// Symbol.dispose and Symbol.asyncDispose where the browser lacks them
// (Safari). The claude package compiles Claude Code's modules for ES2022
// (its build.ts), so esbuild lowers their `using` declarations to a
// helper that looks up Symbol.dispose, or Symbol.for('Symbol.dispose')
// when there is none. A class's [Symbol.dispose]() method, though, has
// the key "undefined" there, and the helper throws "Object not
// disposable". Both use the same symbol once it is defined. TypeScript's
// own helpers fall back to the same Symbol.for names.
export function installDispose(symbols: object = Symbol): void {
  for (const name of ['dispose', 'asyncDispose'])
    if (typeof (symbols as Record<string, unknown>)[name] !== 'symbol')
      Object.defineProperty(symbols, name, { value: Symbol.for(`Symbol.${name}`) });
}

installDispose();
