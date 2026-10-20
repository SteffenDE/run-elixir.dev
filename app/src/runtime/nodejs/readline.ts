// node:readline: keypress events from a stream's bytes (emitKeypressEvents,
// as Node parses a terminal's escape sequences), and Interface: on a
// terminal (input and output TTYs, or `terminal: true`), raw input with
// its own line editing, history and Ctrl+C / Ctrl+D as Node's readline has
// them; otherwise lines as they come. readline/promises' question answers
// a promise.
import { EventEmitter } from 'events';

type Stream = EventEmitter & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(on: boolean): unknown;
  write?(chunk: string): unknown;
  pause?(): unknown;
  resume?(): unknown;
  setEncoding?(encoding: string): unknown;
  columns?: number;
};

export interface Key {
  sequence: string;
  name: string | undefined;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  code?: string;
}

// CSI and SS3 finals and ~-codes, by name, as Node's emitKeys names them.
const FINALS: Record<string, string> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  E: 'clear',
  F: 'end',
  H: 'home',
  P: 'f1',
  Q: 'f2',
  R: 'f3',
  S: 'f4',
  Z: 'tab',
};
const TILDES: Record<string, string> = {
  '1': 'home',
  '2': 'insert',
  '3': 'delete',
  '4': 'end',
  '5': 'pageup',
  '6': 'pagedown',
  '7': 'home',
  '8': 'end',
  '11': 'f1',
  '12': 'f2',
  '13': 'f3',
  '14': 'f4',
  '15': 'f5',
  '17': 'f6',
  '18': 'f7',
  '19': 'f8',
  '20': 'f9',
  '21': 'f10',
  '23': 'f11',
  '24': 'f12',
};

// The keys in `text`: [the characters, the key (undefined for none)].
export function keys(text: string): [string, Key][] {
  const out: [string, Key][] = [];
  let at = 0;
  const key = (sequence: string, name: string | undefined, extra: Partial<Key> = {}): Key => ({
    sequence,
    name,
    ctrl: false,
    meta: false,
    shift: false,
    ...extra,
  });
  while (at < text.length) {
    const ch = text[at];
    if (ch === '\x1b' && at + 1 < text.length && (text[at + 1] === '[' || text[at + 1] === 'O')) {
      // CSI (ESC [ params final) or SS3 (ESC O final).
      // oxlint-disable-next-line no-control-regex -- escape sequences.
      const match = /^\x1b(\[|O)([\d;]*)([~A-Za-z])/.exec(text.slice(at));
      if (match) {
        const [sequence, kind, params, final] = match;
        const parts = params.split(';');
        const modifier = Number(parts[1] ?? 1) - 1;
        const name = final === '~' ? TILDES[parts[0]] : FINALS[final];
        out.push([
          '',
          key(sequence, name, {
            code: `${kind}${final === '~' ? `${parts[0]}~` : final}`,
            shift: Boolean(modifier & 1) || final === 'Z',
            meta: Boolean(modifier & 10),
            ctrl: Boolean(modifier & 4),
          }),
        ]);
        at += sequence.length;
        continue;
      }
    }
    if (ch === '\x1b') {
      // Escape alone, or meta and the next key.
      const next = text[at + 1];
      if (next === undefined || next === '\x1b') {
        out.push(['', key('\x1b', 'escape')]);
        at += 1;
      } else {
        const [, inner] = keys(next)[0];
        out.push(['', { ...inner, sequence: `\x1b${next}`, meta: true }]);
        at += 2;
      }
      continue;
    }
    at += 1;
    if (ch === '\r') out.push(['', key(ch, 'return')]);
    else if (ch === '\n') out.push(['', key(ch, 'enter')]);
    else if (ch === '\t') out.push(['', key(ch, 'tab')]);
    else if (ch === '\x7f' || ch === '\b') out.push(['', key(ch, 'backspace')]);
    else if (ch === ' ') out.push([ch, key(ch, 'space')]);
    else if (ch < ' ')
      out.push(['', key(ch, String.fromCharCode(ch.charCodeAt(0) + 96), { ctrl: true })]);
    else if (/[a-z0-9]/.test(ch)) out.push([ch, key(ch, ch)]);
    else if (/[A-Z]/.test(ch)) out.push([ch, key(ch, ch.toLowerCase(), { shift: true })]);
    else out.push([ch, key(ch, undefined)]);
  }
  return out;
}

const decoding = new WeakSet<object>();

// 'keypress' events (the character, and the key) for what `stream` reads.
export function emitKeypressEvents(stream: Stream): void {
  if (decoding.has(stream)) return;
  decoding.add(stream);
  const decoder = new TextDecoder();
  const onData = (chunk: Uint8Array | string) => {
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    for (const [ch, key] of keys(text)) stream.emit('keypress', ch || undefined, key);
  };
  // Reading only once someone listens for keys, as Node's does.
  const listen = (event: string) => {
    if (event !== 'keypress') return;
    stream.off('newListener', listen);
    stream.on('data', onData);
  };
  if (stream.listenerCount('keypress') > 0) stream.on('data', onData);
  else stream.on('newListener', listen);
}

const write = (stream: Stream | undefined, text: string) => stream?.write?.(text);

export function cursorTo(stream: Stream, x: number, y?: number | (() => void), done?: () => void) {
  if (typeof y === 'function') [done, y] = [y, undefined];
  write(stream, y === undefined ? `\x1b[${x + 1}G` : `\x1b[${y + 1};${x + 1}H`);
  if (done) queueMicrotask(done);
  return true;
}

export function moveCursor(stream: Stream, dx: number, dy: number, done?: () => void) {
  let text = '';
  if (dx) text += dx < 0 ? `\x1b[${-dx}D` : `\x1b[${dx}C`;
  if (dy) text += dy < 0 ? `\x1b[${-dy}A` : `\x1b[${dy}B`;
  if (text) write(stream, text);
  if (done) queueMicrotask(done);
  return true;
}

export function clearLine(stream: Stream, dir: number, done?: () => void) {
  write(stream, dir < 0 ? '\x1b[1K' : dir > 0 ? '\x1b[0K' : '\x1b[2K');
  if (done) queueMicrotask(done);
  return true;
}

export function clearScreenDown(stream: Stream, done?: () => void) {
  write(stream, '\x1b[0J');
  if (done) queueMicrotask(done);
  return true;
}

interface Options {
  input?: Stream;
  output?: Stream;
  terminal?: boolean;
  prompt?: string;
  historySize?: number;
  history?: string[];
  removeHistoryDuplicates?: boolean;
  crlfDelay?: number;
  signal?: AbortSignal;
}

export class Interface extends EventEmitter {
  declare input: Stream | undefined;
  declare output: Stream | undefined;
  declare terminal: boolean;
  declare line: string;
  declare cursor: number;
  declare history: string[];
  declare closed: boolean;
  declare paused: boolean;
  declare historySize: number;
  declare private promptText: string;
  declare private recalled: number;
  declare private asked: ((answer: string) => void) | null;
  declare private buffer: string;
  declare private unhook: () => void;

  constructor(input?: Stream | Options, output?: Stream, _completer?: unknown, terminal?: boolean) {
    super();
    // An options object, or the input stream itself (anything with on()).
    const options: Options =
      input && typeof (input as Stream).on !== 'function'
        ? (input as Options)
        : { input: input as Stream, output, terminal };
    this.input = options.input;
    this.output = options.output;
    this.terminal = options.terminal ?? Boolean(this.input?.isTTY && this.output?.isTTY);
    this.line = '';
    this.cursor = 0;
    this.history = [...(options.history ?? [])];
    this.historySize = options.historySize ?? 30;
    this.closed = false;
    this.paused = false;
    this.promptText = options.prompt ?? '> ';
    this.recalled = -1;
    this.asked = null;
    this.buffer = '';
    const source = this.input;
    if (!source) {
      this.unhook = () => {};
      return;
    }
    if (this.terminal) {
      emitKeypressEvents(source);
      const onKey = (ch: string | undefined, key: Key | undefined) => this.keypress(ch, key);
      source.on('keypress', onKey);
      source.setRawMode?.(true);
      this.unhook = () => {
        source.off('keypress', onKey);
        source.setRawMode?.(false);
      };
    } else {
      const decoder = new TextDecoder();
      const onData = (chunk: Uint8Array | string) =>
        this.lines(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
      const onEnd = () => {
        if (this.buffer) this.emitLine(this.buffer);
        this.buffer = '';
        this.close();
      };
      source.on('data', onData);
      source.on('end', onEnd);
      this.unhook = () => {
        source.off('data', onData);
        source.off('end', onEnd);
      };
    }
    source.resume?.();
    options.signal?.addEventListener('abort', () => this.close(), { once: true });
  }

  private lines(text: string) {
    this.buffer += text;
    for (;;) {
      const at = this.buffer.search(/\r\n|\n|\r/);
      if (at < 0) break;
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + (this.buffer.startsWith('\r\n', at) ? 2 : 1));
      this.emitLine(line);
    }
  }

  private emitLine(line: string) {
    if (this.asked) {
      const answer = this.asked;
      this.asked = null;
      answer(line);
    }
    this.emit('line', line);
  }

  // The line from `from` on, the caret at `cursor`, as typed.
  private refresh() {
    write(this.output, `\r\x1b[0K${this.promptText}${this.line}`);
    const back = this.line.length - this.cursor;
    if (back > 0) write(this.output, `\x1b[${back}D`);
  }

  private keypress(ch: string | undefined, key: Key | undefined) {
    if (this.closed || this.paused) return;
    const name = key?.name;
    if (key?.ctrl && name === 'c') {
      if (this.listenerCount('SIGINT') > 0) this.emit('SIGINT');
      else {
        write(this.output, '^C\r\n');
        this.close();
      }
      return;
    }
    if (key?.ctrl && name === 'd') {
      if (!this.line) {
        write(this.output, '\r\n');
        this.close();
      } else if (this.cursor < this.line.length) {
        this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1);
        this.refresh();
      }
      return;
    }
    if (name === 'return' || name === 'enter') {
      const line = this.line;
      write(this.output, '\r\n');
      this.line = '';
      this.cursor = 0;
      this.recalled = -1;
      if (line && this.history[0] !== line) {
        this.history.unshift(line);
        if (this.history.length > this.historySize) this.history.pop();
        this.emit('history', this.history);
      }
      this.emitLine(line);
      return;
    }
    if (name === 'backspace' || (key?.ctrl && name === 'h')) {
      if (this.cursor > 0) {
        this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor);
        this.cursor--;
        this.refresh();
      }
      return;
    }
    if (name === 'delete') {
      this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1);
      this.refresh();
      return;
    }
    if (name === 'left' || (key?.ctrl && name === 'b')) {
      if (this.cursor > 0) {
        this.cursor--;
        write(this.output, '\x1b[1D');
      }
      return;
    }
    if (name === 'right' || (key?.ctrl && name === 'f')) {
      if (this.cursor < this.line.length) {
        this.cursor++;
        write(this.output, '\x1b[1C');
      }
      return;
    }
    if (name === 'home' || (key?.ctrl && name === 'a')) {
      this.cursor = 0;
      this.refresh();
      return;
    }
    if (name === 'end' || (key?.ctrl && name === 'e')) {
      this.cursor = this.line.length;
      this.refresh();
      return;
    }
    if (key?.ctrl && name === 'u') {
      this.line = this.line.slice(this.cursor);
      this.cursor = 0;
      this.refresh();
      return;
    }
    if (key?.ctrl && name === 'k') {
      this.line = this.line.slice(0, this.cursor);
      this.refresh();
      return;
    }
    if (name === 'up' || name === 'down') {
      const next = Math.max(
        -1,
        Math.min(this.history.length - 1, this.recalled + (name === 'up' ? 1 : -1)),
      );
      this.recalled = next;
      this.line = next < 0 ? '' : this.history[next];
      this.cursor = this.line.length;
      this.refresh();
      return;
    }
    if (ch && !key?.ctrl && !key?.meta) {
      this.line = this.line.slice(0, this.cursor) + ch + this.line.slice(this.cursor);
      this.cursor += ch.length;
      if (this.cursor === this.line.length) write(this.output, ch);
      else this.refresh();
    }
  }

  setPrompt(prompt: string) {
    this.promptText = prompt;
  }
  getPrompt() {
    return this.promptText;
  }
  prompt(preserveCursor?: boolean) {
    if (this.paused) this.resume();
    if (this.terminal) {
      if (!preserveCursor) this.cursor = this.line.length;
      this.refresh();
    } else write(this.output, this.promptText);
  }
  question(query: string, options?: unknown, callback?: (answer: string) => void) {
    if (typeof options === 'function') callback = options as (answer: string) => void;
    if (this.closed)
      throw Object.assign(new Error('readline was closed'), { code: 'ERR_USE_AFTER_CLOSE' });
    // The query is the prompt until it is answered (a terminal redraws
    // the line after it).
    const before = this.promptText;
    this.promptText = query;
    this.asked = (answer) => {
      this.promptText = before;
      callback?.(answer);
    };
    this.prompt();
  }
  // Keys, as if typed (a string), or a key by name.
  write(data: string | undefined, key?: Partial<Key>) {
    if (this.terminal) {
      if (data) for (const [ch, k] of keys(data)) this.keypress(ch || undefined, k);
      else if (key)
        this.keypress(undefined, {
          sequence: '',
          name: undefined,
          ctrl: false,
          meta: false,
          shift: false,
          ...key,
        });
    } else if (data) this.lines(data);
  }
  pause() {
    if (this.paused) return this;
    this.paused = true;
    this.input?.pause?.();
    this.emit('pause');
    return this;
  }
  resume() {
    if (!this.paused) return this;
    this.paused = false;
    this.input?.resume?.();
    this.emit('resume');
    return this;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.unhook();
    this.input?.pause?.();
    this.emit('close');
  }
  getCursorPos() {
    const at = this.promptText.length + this.cursor;
    const columns = this.output?.columns ?? 80;
    return { rows: Math.floor(at / columns), cols: at % columns };
  }
  [Symbol.asyncIterator](): AsyncIterableIterator<string> {
    const queue: string[] = [];
    const waiting: ((result: IteratorResult<string>) => void)[] = [];
    let done = this.closed;
    this.on('line', (line: string) => {
      const next = waiting.shift();
      if (next) next({ value: line, done: false });
      else queue.push(line);
    });
    this.once('close', () => {
      done = true;
      for (const next of waiting.splice(0)) next({ value: undefined, done: true });
    });
    return {
      next: () =>
        queue.length
          ? Promise.resolve({ value: queue.shift()!, done: false })
          : done
            ? Promise.resolve({ value: undefined, done: true })
            : new Promise((resolve) => waiting.push(resolve)),
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
  [Symbol.dispose]() {
    this.close();
  }
}

export function createReadline() {
  const createInterface = (
    input?: Stream | Options,
    output?: Stream,
    completer?: unknown,
    terminal?: boolean,
  ) => new Interface(input, output, completer, terminal);
  class PromisesInterface extends Interface {
    // readline/promises' question answers a promise.
    question(query: string, options?: { signal?: AbortSignal }) {
      return new Promise<string>((resolve, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () =>
            reject(
              Object.assign(new Error('The operation was aborted'), {
                name: 'AbortError',
                code: 'ABORT_ERR',
              }),
            ),
          { once: true },
        );
        super.question(query, resolve);
      });
    }
  }
  const readline = {
    createInterface,
    Interface,
    emitKeypressEvents,
    cursorTo,
    moveCursor,
    clearLine,
    clearScreenDown,
  };
  const promises = {
    ...readline,
    Interface: PromisesInterface,
    createInterface: (
      input?: Stream | Options,
      output?: Stream,
      completer?: unknown,
      terminal?: boolean,
    ) => new PromisesInterface(input, output, completer, terminal),
    Readline: class Readline {
      constructor(private stream: Stream) {}
      cursorTo(x: number, y?: number) {
        cursorTo(this.stream, x, y);
        return this;
      }
      moveCursor(dx: number, dy: number) {
        moveCursor(this.stream, dx, dy);
        return this;
      }
      clearLine(dir: number) {
        clearLine(this.stream, dir);
        return this;
      }
      clearScreenDown() {
        clearScreenDown(this.stream);
        return this;
      }
      commit() {
        return Promise.resolve();
      }
      rollback() {
        return this;
      }
    },
  };
  return { readline: { ...readline, promises }, promises };
}
