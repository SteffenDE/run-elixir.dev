// The published declarations of a JavaScript package (api, pglite):
//
//   node ../types.mjs   (in packages/NAME, after tsc -p tsconfig.build.json)
//
// tsc emits every file of the package's program into dist/types/ (its
// rootDir is packages/, so dist/types/NAME/src/…, and the runtime's files
// the build config names at dist/types/runtime/src/…). This keeps the
// files index.d.ts reaches, makes the runtime's imports relative (the
// runtime package publishes no declarations; its few public types travel
// with the package), and writes dist/index.d.ts. Imports of other
// packages stay package imports, by their main entry.
import { existsSync, readFileSync, rmSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

const here = process.cwd();
const name = basename(here);
const types = join(here, 'dist', 'types');
const entry = join(types, name, 'src', 'index.d.ts');
const SPEC = /((?:from|import)\s*\(?\s*)(['"])([^'"]+)\2/g;

const relativeTo = (from, to) => {
  const path = relative(dirname(from), to).replace(/\.d\.ts$/, '');
  return path.startsWith('.') ? path : `./${path}`;
};
function resolve(file, spec) {
  let base = null;
  if (spec.startsWith('.')) base = join(dirname(file), spec);
  else if (spec.startsWith('@elixir-playground/runtime/'))
    base = join(types, 'runtime', 'src', spec.slice('@elixir-playground/runtime/'.length));
  if (!base) return null;
  for (const candidate of [`${base}.d.ts`, join(base, 'index.d.ts')])
    if (existsSync(candidate)) return candidate;
  throw new Error(`${relative(here, file)}: ${spec} has no declarations (name it in tsconfig.build.json)`);
}

const kept = new Set();
const todo = [entry];
while (todo.length) {
  const file = todo.pop();
  if (kept.has(file)) continue;
  kept.add(file);
  const text = readFileSync(file, 'utf8').replace(SPEC, (all, lead, quote, spec) => {
    const target = resolve(file, spec);
    if (target) {
      todo.push(target);
      return `${lead}${quote}${relativeTo(file, target)}${quote}`;
    }
    // Another package of ours: by its main entry, which exports its types.
    const own = spec.match(/^(@elixir-playground\/[^/]+)\//);
    return own ? `${lead}${quote}${own[1]}${quote}` : all;
  });
  writeFileSync(file, text);
}

// Everything else tsc emitted goes.
(function prune(directory) {
  for (const item of readdirSync(directory)) {
    const path = join(directory, item);
    if (statSync(path).isDirectory()) {
      prune(path);
      if (!readdirSync(path).length) rmSync(path, { recursive: true });
    } else if (!kept.has(path)) rmSync(path);
  }
})(types);

const index = relativeTo(join(here, 'dist', 'index.d.ts'), entry);
const exportsDefault = /export default|export \{[^}]*\bdefault\b/.test(readFileSync(entry, 'utf8'));
writeFileSync(
  join(here, 'dist', 'index.d.ts'),
  `export * from '${index}';\n` + (exportsDefault ? `export { default } from '${index}';\n` : ''),
);
console.log(`${name}: dist/index.d.ts, ${kept.size} declaration files`);
