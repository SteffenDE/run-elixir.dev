// inotifywait on the page, for file_system (Phoenix's live reload): the
// node's and the editor's changes (watch.ts) below the watched paths, one
// line each in inotify-tools' format. A change comes without its kind: a
// file that is there was written (CLOSE_WRITE, or MODIFY when only that is
// asked for), a directory that is there was created, one that is gone was
// deleted. -e, --format, -m, -r, -q and --exclude/--include(i); without -m
// it exits after the first event, else when it is killed (file_system's
// sh -c line runs it in the background, and kills it when its port's
// input ends).
import { path } from './modules';
import type { Context, Process } from './tailwind';
import { type Watcher, watchers } from './watch';

const USAGE = 'inotifywait [-m] [-r] [-q] [-e event]... [--format fmt] [--exclude re] file...\n';

interface Options {
  monitor: boolean;
  recursive: boolean;
  quiet: number;
  events: Set<string>;
  format: string | null;
  exclude: RegExp | null;
  include: RegExp | null;
  files: string[];
}

function parse(args: string[]): Options | string {
  const options: Options = {
    monitor: false,
    recursive: false,
    quiet: 0,
    events: new Set(),
    format: null,
    exclude: null,
    include: null,
    files: [],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = () => {
      if (i + 1 >= args.length) throw new Error(`${arg} needs a value`);
      return args[++i];
    };
    try {
      if (arg === '-m' || arg === '--monitor') options.monitor = true;
      else if (arg === '-r' || arg === '--recursive') options.recursive = true;
      else if (arg === '-q' || arg === '--quiet') options.quiet++;
      else if (arg === '-qq') options.quiet += 2;
      else if (arg === '-e' || arg === '--event')
        for (const event of value().split(',')) options.events.add(event.toUpperCase());
      else if (arg === '--format') options.format = value();
      else if (arg === '--exclude') options.exclude = new RegExp(value());
      else if (arg === '--excludei') options.exclude = new RegExp(value(), 'i');
      else if (arg === '--include') options.include = new RegExp(value());
      else if (arg === '--includei') options.include = new RegExp(value(), 'i');
      else if (arg === '--') {
        options.files.push(...args.slice(i + 1));
        break;
      } else if (arg === '-h' || arg === '--help') return USAGE;
      else if (arg.startsWith('-') && arg !== '-') return `inotifywait: unknown option ${arg}\n`;
      else options.files.push(arg);
    } catch (error) {
      return `inotifywait: ${(error as Error).message}\n`;
    }
  }
  return options;
}

// %w, %f, %e and %Xe (the events with X between them), %%; the rest as is.
function line(format: string | null, watched: string, file: string, events: string[]): string {
  if (format === null) return `${watched} ${events.join(',')} ${file}\n`;
  return (
    format.replace(/%(%|w|f|e|.e)/g, (_, spec: string) =>
      spec === '%'
        ? '%'
        : spec === 'w'
          ? watched
          : spec === 'f'
            ? file
            : events.join(spec === 'e' ? ',' : spec[0]),
    ) + '\n'
  );
}

export async function inotifywait(process: Process, { args, cwd, fs }: Context): Promise<void> {
  const options = parse(args);
  if (typeof options === 'string') {
    process.write(options);
    process.exit(options === USAGE ? 0 : 1);
    return;
  }
  if (!options.files.length) {
    process.write('inotifywait: no files specified to watch\n');
    process.exit(1);
    return;
  }
  const roots = await Promise.all(
    options.files.map(async (file) => {
      const at = path.resolve(cwd, file);
      return { at, kind: await fs.stat(at) };
    }),
  );
  const missing = roots.find(({ kind }) => kind === null);
  if (missing) {
    process.write(`Couldn't watch ${missing.at}: No such file or directory\n`);
    process.exit(1);
    return;
  }
  const wanted = (event: string) => !options.events.size || options.events.has(event);
  if (options.quiet < 1)
    process.write(
      `${options.recursive ? 'Setting up watches.  Beware: since -r was given, this may take a while!' : 'Setting up watches.'}\nWatches established.\n`,
    );

  // The watched path a change is below, as inotify reports it: a watched
  // file itself, or a directory (with its slash) and the name in it.
  const place = (changed: string): [string, string] | null => {
    for (const { at, kind } of roots) {
      if (kind === 'file') {
        if (changed === at) return [at, ''];
        continue;
      }
      if (!changed.startsWith(`${at === '/' ? '' : at}/`)) continue;
      const dir = path.dirname(changed);
      if (!options.recursive && dir !== at) continue;
      return [`${dir}/`, path.basename(changed)];
    }
    return null;
  };

  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    watchers.delete(watcher);
  };
  // In the order they came, one change at a time.
  let queue = Promise.resolve();
  const report = async (changed: string) => {
    if (done) return;
    const at = place(changed);
    if (!at) return;
    if (options.exclude?.test(changed)) return;
    if (options.include && !options.include.test(changed)) return;
    const kind = await fs.stat(changed).catch(() => null);
    let events: string[];
    if (kind === null) events = ['DELETE'];
    else if (kind === 'dir') events = ['CREATE', 'ISDIR'];
    else if (wanted('CLOSE_WRITE') || wanted('CLOSE')) events = ['CLOSE_WRITE', 'CLOSE'];
    else events = ['MODIFY'];
    if (!wanted(events[0])) return;
    if (done) return;
    process.write(line(options.format, at[0], at[1], events));
    if (!options.monitor) {
      stop();
      process.exit(0);
    }
  };
  const watcher: Watcher = (paths) => {
    for (const changed of new Set(paths)) queue = queue.then(() => report(changed));
  };
  watchers.add(watcher);
  process.onkill = stop;
  process.onowner = stop;
}
