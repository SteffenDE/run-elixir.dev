// tailwindcss on the page, in place of the CLI the Hex package downloads:
// `--input`, `--output`, `--watch` and `--help` (its version check), with
// Tailwind v4's own compiler. Plugins are the app's CommonJS files; sources
// are the node's files, scanned for candidates. In watch mode it rebuilds
// when the node or the editor changes a source.
import { compile } from 'tailwindcss';
import plugin from 'tailwindcss/plugin';
import indexCss from 'tailwindcss/index.css?raw';
import preflightCss from 'tailwindcss/preflight.css?raw';
import themeCss from 'tailwindcss/theme.css?raw';
import utilitiesCss from 'tailwindcss/utilities.css?raw';
import type { FileSystem as Files } from '@/runtime/host/files';
import { SyncFiles, evaluate, made, path, withFaults } from './modules';
import { type Watcher, watchers } from './watch';

export const TAILWIND_VERSION = '4.3.3';

const PACKAGE = '/__tailwindcss';
const BUNDLED: Record<string, string> = {
  [`${PACKAGE}/index.css`]: indexCss,
  [`${PACKAGE}/preflight.css`]: preflightCss,
  [`${PACKAGE}/theme.css`]: themeCss,
  [`${PACKAGE}/utilities.css`]: utilitiesCss,
};

// Files whose text is never a class list.
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|eot|mp4|webm|zip|gz|beam|wasm)$/i;

export interface Process {
  write(data: string | Uint8Array): void;
  exit(code?: number): void;
  onkill: (() => void) | null;
}

export interface Context {
  args: string[];
  cwd: string;
  env: Record<string, string>;
  fs: Files;
}

// Called after each build in watch mode (the preview refreshes its CSS).
export const built = new Set<(output: string) => void>();

function option(args: string[], long: string, short: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith(`${long}=`)) return arg.slice(long.length + 1);
    if (arg === long || arg === short) return args[i + 1];
  }
  return undefined;
}

const decoder = new TextDecoder();

export async function tailwind(process: Process, { args, cwd, env, fs }: Context): Promise<void> {
  if (args.includes('--help') || args.includes('-h') || args.includes('--version')) {
    process.write(`≈ tailwindcss v${TAILWIND_VERSION}\n`);
    process.exit(0);
    return;
  }
  const input = option(args, '--input', '-i');
  const output = option(args, '--output', '-o');
  const watch = args.some((arg) => arg === '--watch' || arg.startsWith('--watch='));
  if (!input || !output) {
    process.write('tailwindcss: the playground needs --input and --output\n');
    process.exit(1);
    return;
  }
  const inputPath = path.resolve(cwd, input);
  const outputPath = path.resolve(cwd, output);
  const nodePath = (env.NODE_PATH ?? '').split(':').filter(Boolean);
  const files = new SyncFiles(fs);

  const readText = async (file: string) => decoder.decode(await fs.read(file));
  // A module or stylesheet id, from `base` or NODE_PATH, with the extensions
  // Node and Tailwind try.
  const locate = async (id: string, base: string, extensions: string[]) => {
    const roots = id.startsWith('.') || id.startsWith('/') ? [base] : [base, ...nodePath];
    for (const root of roots) {
      for (const extension of extensions) {
        const candidate = path.resolve(root, id + extension);
        try {
          return { path: candidate, content: await readText(candidate) };
        } catch {
          // Next.
        }
      }
    }
    throw new Error(`Can't resolve '${id}' from ${base}`);
  };

  let sources: string[] = [];
  let watched: string[] = [];

  const build = async () => {
    const started = performance.now();
    const css = await readText(inputPath);
    watched = [inputPath];
    const compiler = await withFaults(files, () =>
      compile(css, {
        base: path.dirname(inputPath),
        from: inputPath,
        async loadStylesheet(id, base) {
          if (id === 'tailwindcss' || id.startsWith('tailwindcss/')) {
            const file =
              id === 'tailwindcss' ? `${PACKAGE}/index.css` : `${PACKAGE}/${id.slice(12)}`;
            const name = file.endsWith('.css') ? file : `${file}.css`;
            return { path: name, base: PACKAGE, content: BUNDLED[name] ?? '' };
          }
          if (base === PACKAGE) {
            const name = path.join(PACKAGE, id);
            return { path: name, base: PACKAGE, content: BUNDLED[name] ?? '' };
          }
          const found = await locate(id, base, ['', '.css', '/index.css']);
          watched.push(found.path);
          return { path: found.path, base: path.dirname(found.path), content: found.content };
        },
        async loadModule(id, base) {
          const found = await locate(id, base, ['', '.js', '.cjs', '/index.js']);
          watched.push(found.path);
          const module = evaluate(
            found.content,
            found.path,
            { 'tailwindcss/plugin': plugin, fs: files.fs, path },
            files,
          );
          const value = (module as { default?: unknown })?.default ?? module;
          return { path: found.path, base: path.dirname(found.path), module: value as never };
        },
      }),
    );
    // Sources: @source paths up to their first glob, scanned whole.
    sources = compiler.sources
      .filter((source) => !source.negated)
      .map((source) => {
        const parts = path.resolve(source.base, source.pattern).split('/');
        const glob = parts.findIndex((part) => /[*{?[]/.test(part));
        return glob < 0 ? parts.join('/') : parts.slice(0, glob).join('/');
      });
    if (compiler.root && compiler.root !== 'none')
      sources.push(path.resolve(compiler.root.base, compiler.root.pattern));
    const candidates = new Set<string>();
    for (const dir of sources) {
      const entries = await fs.list(dir).catch(() => [{ path: dir, dir: false }]);
      const texts = await Promise.all(
        entries
          .filter((entry) => !entry.dir && !BINARY.test(entry.path) && entry.path !== outputPath)
          .map((entry) => readText(entry.path).catch(() => '')),
      );
      for (const text of texts) {
        for (const token of text.split(/[\s"'`<>={};]+/)) {
          const candidate = token.replace(/^[,.:]+|[,.:]+$/g, '');
          if (candidate && candidate.length < 200) candidates.add(candidate);
        }
      }
    }
    const result = await withFaults(files, () => compiler.build([...candidates]));
    // The tailwind CLI makes the output's directory, as a new app's first
    // build needs (priv/static/assets/css is in no template).
    await made(fs, path.dirname(outputPath));
    await fs.write(outputPath, result);
    process.write(`\nDone in ${Math.round(performance.now() - started)}ms.\n`);
    for (const listener of built) listener(outputPath);
  };

  process.write(`≈ tailwindcss v${TAILWIND_VERSION}\n`);
  try {
    await build();
  } catch (error) {
    process.write(`Error: ${(error as Error).message}\n`);
    if (!watch) {
      process.exit(1);
      return;
    }
  }
  if (!watch) {
    process.exit(0);
    return;
  }
  // Rebuild when a source, the input or one of its imports changes.
  let pending: ReturnType<typeof setTimeout> | null = null;
  const watcher: Watcher = (paths) => {
    const relevant = paths.some(
      (changed) =>
        changed !== outputPath &&
        (watched.includes(changed) ||
          sources.some((dir) => changed === dir || changed.startsWith(`${dir}/`))),
    );
    if (!relevant) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      build().catch((error: Error) => process.write(`Error: ${error.message}\n`));
    }, 50);
  };
  watchers.add(watcher);
  process.onkill = () => {
    watchers.delete(watcher);
    if (pending) clearTimeout(pending);
  };
}
