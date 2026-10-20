// Node's util: format and inspect as console.log prints values, and the
// helpers packages use (promisify, inherits, deprecate, types, …).
import { Buffer } from './buffer';

export interface InspectOptions {
  depth?: number | null;
  colors?: boolean;
  compact?: boolean | number;
  breakLength?: number;
  showHidden?: boolean;
}

const custom = Symbol.for('nodejs.util.inspect.custom');

const COLORS: Record<string, [number, number]> = {
  number: [33, 39],
  bigint: [33, 39],
  boolean: [33, 39],
  string: [32, 39],
  undefined: [90, 39],
  null: [1, 22],
  symbol: [32, 39],
  special: [36, 39],
  date: [35, 39],
  regexp: [31, 39],
};

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

// An error as Node prints it: its name and message, then its frames as
// "at …" whatever the engine wrote (V8's "at f (url)", SpiderMonkey's and
// JavaScriptCore's "f@url"), without the runtime's own frames.
export function stackOf(error: Error): string {
  const header = error.message ? `${error.name}: ${error.message}` : String(error.name);
  const frames: string[] = [];
  const stack = String(error.stack ?? '');
  // V8's stack starts with the message, which may hold an @.
  const isV8 = /^\s+at /m.test(stack);
  for (const line of stack.split('\n')) {
    let frame: string;
    const v8 = /^\s+at (.*)$/.exec(line);
    // JavaScriptCore's frames in eval'd code may have no location.
    const other = isV8 ? null : /^([^@]*)@(.*)$/.exec(line);
    if (v8) frame = v8[1];
    else if (other && (other[1] || other[2]))
      frame = other[1] && other[2] ? `${other[1]} (${other[2]})` : other[1] || other[2];
    else continue;
    if (/\/nodejs\.js|\[native code\]|^eval \(eval at/.test(frame)) continue;
    frames.push(`    at ${frame.replaceAll('file://', '')}`);
  }
  return [header, ...frames].join('\n');
}

function quote(text: string): string {
  const q = !text.includes("'") ? "'" : !text.includes('"') ? '"' : !text.includes('`') ? '`' : "'";
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(new RegExp(q, 'g'), `\\${q}`);
  return `${q}${escaped}${q}`;
}

export function inspect(value: unknown, options: InspectOptions = {}): string {
  const depth = options.depth === null ? Infinity : (options.depth ?? 2);
  const breakLength = options.breakLength ?? 80;
  const seen: unknown[] = [];
  const style = (text: string, kind: string) => {
    if (!options.colors || !COLORS[kind]) return text;
    const [open, close] = COLORS[kind];
    return `\x1b[${open}m${text}\x1b[${close}m`;
  };

  const show = (v: unknown, level: number, nested: boolean): string => {
    switch (typeof v) {
      case 'string':
        return nested ? style(quote(v), 'string') : v;
      case 'number':
        return style(Object.is(v, -0) ? '-0' : String(v), 'number');
      case 'bigint':
        return style(`${v}n`, 'bigint');
      case 'boolean':
        return style(String(v), 'boolean');
      case 'undefined':
        return style('undefined', 'undefined');
      case 'symbol':
        return style(v.toString(), 'symbol');
      case 'function': {
        const name = v.name ? `: ${v.name}` : ' (anonymous)';
        const kind = /^class\s/.test(Function.prototype.toString.call(v)) ? 'class' : 'Function';
        const head = kind === 'class' ? `[class ${v.name || '(anonymous)'}]` : `[${kind}${name}]`;
        const keys = Object.keys(v);
        if (!keys.length || level > depth) return style(head, 'special');
        return entries(v as object, keys, level, style(head, 'special'), '{', '}');
      }
    }
    if (v === null) return style('null', 'null');
    const object = v as Record<PropertyKey, unknown>;
    if (typeof object[custom] === 'function') {
      // A string as it is, another value inspected; itself, as it is shown.
      const shown = (object[custom] as (d: number, o: unknown, i: unknown) => unknown)(
        depth - level,
        options,
        inspect,
      );
      if (shown !== v) return typeof shown === 'string' ? shown : show(shown, level, nested);
    }
    if (seen.includes(v)) return style('[Circular *1]', 'special');
    if (v instanceof Error) {
      const stack = stackOf(v);
      const extra = Object.keys(v).filter((key) => key !== 'stack' && key !== 'message');
      if (!extra.length || level > depth) return nested ? `[${stack}]` : stack;
      return entries(v, extra, level, stack, '{', '}');
    }
    if (v instanceof Date)
      return style(Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString(), 'date');
    if (v instanceof RegExp) return style(String(v), 'regexp');
    if (v instanceof Promise) return 'Promise { <pending> }';
    if (Buffer.isBuffer(v)) {
      const hex = [...v.subarray(0, 50)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      return `<Buffer${hex ? ` ${hex}` : ''}${v.length > 50 ? ` ... ${v.length - 50} more bytes` : ''}>`;
    }
    if (level > depth) {
      if (Array.isArray(v)) return style('[Array]', 'special');
      const name = (v as object).constructor?.name;
      return style(`[${name && name !== 'Object' ? name : 'Object'}]`, 'special');
    }
    seen.push(v);
    try {
      if (Array.isArray(v)) {
        // A run of holes is one item: <n empty items>.
        const items: string[] = [];
        let i = 0;
        for (; i < v.length && items.length < 100; i++) {
          if (i in v) {
            items.push(show(v[i], level + 1, true));
            continue;
          }
          let end = i;
          while (end + 1 < v.length && !(end + 1 in v)) end++;
          const holes = end - i + 1;
          items.push(style(`<${holes} empty item${holes === 1 ? '' : 's'}>`, 'undefined'));
          i = end;
        }
        const more = v.length - i;
        if (more) items.push(`... ${more} more item${more === 1 ? '' : 's'}`);
        const extra = Object.keys(v).filter((key) => !/^\d+$/.test(key));
        for (const key of extra) items.push(`${key}: ${show(object[key], level + 1, true)}`);
        return wrap(items, level, '', '[', ']');
      }
      if (ArrayBuffer.isView(v)) {
        const array = v as unknown as ArrayLike<number>;
        const items = Array.from({ length: Math.min(array.length, 100) }, (_, i) =>
          show(array[i], level + 1, true),
        );
        return wrap(items, level, `${v.constructor.name}(${array.length}) `, '[', ']');
      }
      if (v instanceof Map) {
        const items = [...v].map(
          ([k, item]) => `${show(k, level + 1, true)} => ${show(item, level + 1, true)}`,
        );
        return wrap(items, level, `Map(${v.size}) `, '{', '}');
      }
      if (v instanceof Set) {
        const items = [...v].map((item) => show(item, level + 1, true));
        return wrap(items, level, `Set(${v.size}) `, '{', '}');
      }
      const proto = Object.getPrototypeOf(v);
      const name = proto === null ? '[Object: null prototype]' : proto.constructor?.name;
      const prefix = !name || name === 'Object' ? '' : `${name} `;
      const keys: PropertyKey[] = [
        ...Object.keys(v as object),
        ...Object.getOwnPropertySymbols(v as object),
      ];
      return entries(v as object, keys, level, prefix.trim(), '{', '}');
    } finally {
      seen.pop();
    }
  };

  const entries = (
    v: object,
    keys: PropertyKey[],
    level: number,
    prefix: string,
    open: string,
    close: string,
  ) => {
    const object = v as Record<PropertyKey, unknown>;
    const items = keys.map((key) => {
      const name =
        typeof key === 'symbol'
          ? `[${key.toString()}]`
          : IDENTIFIER.test(key as string)
            ? (key as string)
            : quote(key as string);
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      const shown =
        descriptor && descriptor.get && !('value' in descriptor)
          ? style(descriptor.set ? '[Getter/Setter]' : '[Getter]', 'special')
          : show(object[key], level + 1, true);
      return `${name}: ${shown}`;
    });
    if (!items.length) return prefix ? `${prefix} ${open}${close}` : `${open}${close}`;
    return wrap(items, level, prefix ? `${prefix} ` : '', open, close);
  };

  const wrap = (items: string[], level: number, prefix: string, open: string, close: string) => {
    if (!items.length) return `${prefix}${open}${close}`;
    const flat = `${prefix}${open} ${items.join(', ')} ${close}`;
    // oxlint-disable-next-line no-control-regex -- ANSI colors.
    const plain = flat.replace(/\x1b\[\d+m/g, '');
    if (plain.length + level * 2 <= breakLength && !plain.includes('\n')) return flat;
    const indent = '  '.repeat(level + 1);
    return `${prefix}${open}\n${items.map((item) => indent + item.replace(/\n/g, `\n${indent}`)).join(',\n')}\n${'  '.repeat(level)}${close}`;
  };

  return show(value, 0, false);
}
inspect.custom = custom;
inspect.defaultOptions = { depth: 2, colors: false };

const number = (n: number) => (Object.is(n, -0) ? '-0' : String(n));

// Whether %s inspects `value`: its toString is JavaScript's own, not a
// class's or Symbol.toPrimitive (a Date is inspected still).
function builtInToString(value: object): boolean {
  if (value instanceof Date) return true;
  const object = value as Record<PropertyKey, unknown>;
  if (typeof object[Symbol.toPrimitive] === 'function') return false;
  if (typeof object.toString !== 'function') return true;
  let owner: object | null = value;
  while (owner && !Object.prototype.hasOwnProperty.call(owner, 'toString'))
    owner = Object.getPrototypeOf(owner);
  if (owner === value) return false;
  const made = owner && Object.getOwnPropertyDescriptor(owner, 'constructor')?.value;
  return (
    typeof made === 'function' &&
    /^(Object|Function|Array|Number|Boolean|String|Symbol|BigInt|Date|RegExp|Promise|Map|Set|WeakMap|WeakSet|ArrayBuffer|DataView|\w*Error)$/.test(
      made.name,
    )
  );
}

export function format(...args: unknown[]): string {
  return formatWithOptions({}, ...args);
}

export function formatWithOptions(options: InspectOptions, ...args: unknown[]): string {
  let out = '';
  let rest = args;
  if (typeof args[0] === 'string') {
    let index = 1;
    out = args[0].replace(/%([sdifjoOc%])/g, (match, kind: string) => {
      if (kind === '%') return '%';
      if (index >= args.length) return match;
      const value = args[index++];
      switch (kind) {
        case 's':
          return typeof value === 'number'
            ? number(value)
            : typeof value === 'bigint'
              ? `${value}n`
              : typeof value === 'object' && value !== null && builtInToString(value)
                ? inspect(value, { ...options, depth: 0, colors: false })
                : String(value);
        case 'd':
          return typeof value === 'bigint'
            ? `${value}n`
            : typeof value === 'symbol'
              ? 'NaN'
              : number(Number(value));
        case 'i':
          return typeof value === 'bigint'
            ? `${value}n`
            : typeof value === 'symbol'
              ? 'NaN'
              : String(parseInt(String(value), 10));
        case 'f':
          return typeof value === 'symbol' ? 'NaN' : String(parseFloat(String(value)));
        case 'j':
          try {
            return JSON.stringify(value);
          } catch {
            return '[Circular]';
          }
        case 'o':
          return inspect(value, { ...options, showHidden: true, depth: 4 });
        case 'O':
          return inspect(value, options);
        default:
          return '';
      }
    });
    rest = args.slice(index);
  } else {
    out = args.length ? inspect(args[0], options) : '';
    rest = args.slice(1);
  }
  for (const value of rest)
    out += ` ${typeof value === 'string' ? value : inspect(value, options)}`;
  return out;
}

const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');

export function promisify(fn: (...args: unknown[]) => void) {
  const own = (fn as unknown as Record<symbol, unknown>)[promisifyCustom];
  if (typeof own === 'function') return own;
  return function (this: unknown, ...args: unknown[]) {
    return new Promise((resolve, reject) => {
      fn.call(this, ...args, (error: unknown, value: unknown) =>
        error ? reject(error) : resolve(value),
      );
    });
  };
}
promisify.custom = promisifyCustom;

const isType = (tag: string) => (v: unknown) =>
  Object.prototype.toString.call(v) === `[object ${tag}]`;

export const types = {
  isPromise: (v: unknown) => v instanceof Promise,
  isDate: (v: unknown) => v instanceof Date,
  isRegExp: (v: unknown) => v instanceof RegExp,
  isMap: (v: unknown) => v instanceof Map,
  isSet: (v: unknown) => v instanceof Set,
  isNativeError: (v: unknown) => v instanceof Error,
  isTypedArray: (v: unknown) => ArrayBuffer.isView(v) && !(v instanceof DataView),
  isUint8Array: (v: unknown) => v instanceof Uint8Array,
  isArrayBuffer: (v: unknown) => v instanceof ArrayBuffer,
  isAnyArrayBuffer: (v: unknown) => v instanceof ArrayBuffer || v instanceof SharedArrayBuffer,
  isArrayBufferView: (v: unknown) => ArrayBuffer.isView(v),
  isAsyncFunction: isType('AsyncFunction'),
  isGeneratorFunction: (v: unknown) =>
    isType('GeneratorFunction')(v) || isType('AsyncGeneratorFunction')(v),
  isGeneratorObject: isType('Generator'),
  isBoxedPrimitive: (v: unknown) =>
    v instanceof Number ||
    v instanceof String ||
    v instanceof Boolean ||
    v instanceof BigInt ||
    v instanceof Symbol,
  isProxy: () => false,
  isWeakMap: (v: unknown) => v instanceof WeakMap,
  isWeakSet: (v: unknown) => v instanceof WeakSet,
  isDataView: (v: unknown) => v instanceof DataView,
};

// As Node's: a regular expression's source and flags, an error's name and
// message (and cause), a boxed primitive's value, a view's bytes, a Set's
// or a Map's objects by an equal one, enumerable symbol keys too, and
// cycles.
export function isDeepStrictEqual(
  a: unknown,
  b: unknown,
  seen = new Map<object, Set<object>>(),
): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const tag = Object.prototype.toString.call(a);
  if (tag !== Object.prototype.toString.call(b)) return false;
  if (seen.get(a)?.has(b)) return true;
  if (!seen.has(a)) seen.set(a, new Set());
  seen.get(a)!.add(b);
  const equal = (x: unknown, y: unknown) => isDeepStrictEqual(x, y, seen);
  if (a instanceof Date && a.getTime() !== (b as Date).getTime()) return false;
  if (a instanceof RegExp) {
    const other = b as RegExp;
    if (String(a) !== String(other) || a.lastIndex !== other.lastIndex) return false;
  }
  if (a instanceof Error) {
    const other = b as Error;
    if (a.name !== other.name || a.message !== other.message) return false;
    if (('cause' in a || 'cause' in other) && !equal(a.cause, other.cause)) return false;
  }
  if (/^\[object (Number|String|Boolean|BigInt|Symbol)\]$/.test(tag)) {
    const value = (x: object) => (x as { valueOf(): unknown }).valueOf();
    if (!Object.is(value(a), value(b))) return false;
  }
  if (ArrayBuffer.isView(a)) {
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const y = new Uint8Array((b as ArrayBufferView).buffer, (b as ArrayBufferView).byteOffset);
    if (x.length !== (b as ArrayBufferView).byteLength || x.some((byte, i) => byte !== y[i]))
      return false;
  }
  // `item`'s match among `others`' objects not matched yet.
  const match = (item: unknown, others: Iterable<unknown>, used: Set<unknown>, ok = equal) => {
    if (typeof item !== 'object' || item === null) return false;
    for (const other of others)
      if (!used.has(other) && ok(item, other)) {
        used.add(other);
        return true;
      }
    return false;
  };
  if (a instanceof Map) {
    const other = b as Map<unknown, unknown>;
    if (a.size !== other.size) return false;
    const used = new Set<unknown>();
    for (const [k, v] of a) {
      if (other.has(k) && (typeof k !== 'object' || k === null || !used.has(k))) {
        if (!equal(v, other.get(k))) return false;
        used.add(k);
      } else if (!match(k, other.keys(), used, (x, y) => equal(x, y) && equal(v, other.get(y))))
        return false;
    }
  }
  if (a instanceof Set) {
    const other = b as Set<unknown>;
    if (a.size !== other.size) return false;
    const used = new Set<unknown>();
    for (const v of a)
      if (other.has(v)) used.add(v);
      else if (!match(v, other, used)) return false;
  }
  if (ArrayBuffer.isView(a)) return true;
  const keys = (x: object) => [
    ...Object.keys(x),
    ...Object.getOwnPropertySymbols(x).filter((s) =>
      Object.prototype.propertyIsEnumerable.call(x, s),
    ),
  ];
  const ka = keys(a);
  if (ka.length !== keys(b).length) return false;
  return ka.every(
    (k) =>
      Object.prototype.propertyIsEnumerable.call(b, k) &&
      equal((a as Record<PropertyKey, unknown>)[k], (b as Record<PropertyKey, unknown>)[k]),
  );
}

interface ArgOption {
  type: 'boolean' | 'string';
  short?: string;
  multiple?: boolean;
  default?: unknown;
}

type ArgToken =
  | {
      kind: 'option';
      name: string;
      rawName: string;
      index: number;
      value: string | undefined;
      inlineValue: boolean | undefined;
    }
  | { kind: 'positional'; index: number; value: string }
  | { kind: 'option-terminator'; index: number };

const argError = (code: string, message: string) => Object.assign(new TypeError(message), { code });

// util.parseArgs, as Node's: --name, --name=value, -n, -abc (booleans
// grouped), -nvalue, --no-name (allowNegative), -- ending the options;
// strict refuses an unknown option, a string without its value and a
// positional unless allowed.
function parseArgs(
  config: {
    args?: string[];
    options?: Record<string, ArgOption>;
    strict?: boolean;
    allowPositionals?: boolean;
    allowNegative?: boolean;
    tokens?: boolean;
  } = {},
) {
  const args =
    config.args ?? (globalThis as { process?: { argv: string[] } }).process!.argv.slice(2);
  const options = config.options ?? {};
  const strict = config.strict ?? true;
  const allowPositionals = config.allowPositionals ?? !strict;
  const byShort = new Map(
    Object.entries(options)
      .filter(([, o]) => o.short)
      .map(([name, o]) => [o.short!, name]),
  );
  const values: Record<string, unknown> = Object.create(null);
  const positionals: string[] = [];
  const tokens: ArgToken[] = [];
  const store = (name: string, value: unknown) => {
    if (options[name]?.multiple) ((values[name] as unknown[]) ??= []).push(value);
    else values[name] = value;
  };
  // An option `name` as written (`raw`), its value (inline or the next
  // argument's) as its type asks.
  const option = (index: number, raw: string, name: string, inline: string | undefined) => {
    let known = options[name];
    let negated = false;
    if (
      !known &&
      config.allowNegative &&
      name.startsWith('no-') &&
      options[name.slice(3)]?.type === 'boolean'
    ) {
      name = name.slice(3);
      known = options[name];
      negated = true;
    }
    if (!known && strict)
      throw argError(
        'ERR_PARSE_ARGS_UNKNOWN_OPTION',
        `Unknown option '${raw}'${allowPositionals ? `. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- "${raw}"` : ''}`,
      );
    let value: string | undefined = inline;
    let consumed = 0;
    if (known?.type === 'string' && value === undefined) {
      value = args[index + 1];
      if (value === undefined || (strict && value.startsWith('-')))
        throw argError(
          'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
          `Option '${raw}${known.short && raw.startsWith('--') ? `, -${known.short}` : ''} <value>' argument missing`,
        );
      consumed = 1;
    } else if (known?.type === 'boolean' && value !== undefined && strict)
      throw argError(
        'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
        `Option '${raw}' does not take an argument`,
      );
    tokens.push({
      kind: 'option',
      name,
      rawName: raw,
      index,
      value,
      inlineValue: value === undefined ? undefined : inline !== undefined,
    });
    store(name, known?.type === 'string' ? value : value === undefined ? !negated : value);
    return consumed;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      tokens.push({ kind: 'option-terminator', index: i });
      for (let j = i + 1; j < args.length; j++) {
        tokens.push({ kind: 'positional', index: j, value: args[j] });
        positionals.push(args[j]);
      }
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      i += option(i, eq < 0 ? arg : arg.slice(0, eq), name, eq < 0 ? undefined : arg.slice(eq + 1));
    } else if (arg.startsWith('-') && arg.length > 1) {
      // -abc: booleans each; -nvalue: a string's value after its letter.
      for (let at = 1; at < arg.length; at++) {
        const letter = arg[at];
        const name = byShort.get(letter) ?? letter;
        const rest = arg.slice(at + 1);
        if (options[name]?.type === 'string' && rest) {
          option(i, `-${letter}`, name, rest);
          break;
        }
        i += option(i, `-${letter}`, name, undefined);
      }
    } else {
      if (strict && !allowPositionals)
        throw argError(
          'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL',
          `Unexpected argument '${arg}'. This command does not take positional arguments`,
        );
      tokens.push({ kind: 'positional', index: i, value: arg });
      positionals.push(arg);
    }
  }
  for (const [name, o] of Object.entries(options))
    if (values[name] === undefined && o.default !== undefined) values[name] = o.default;
  return config.tokens ? { values, positionals, tokens } : { values, positionals };
}

export function createUtil(warn: (text: string) => void) {
  const warned = new Set<string>();
  return {
    format,
    formatWithOptions,
    inspect,
    promisify,
    callbackify:
      (fn: (...args: unknown[]) => Promise<unknown>) =>
      (...args: unknown[]) => {
        const done = args.pop() as (e: unknown, v?: unknown) => void;
        fn(...args).then(
          (v) => done(null, v),
          (e) => done(e),
        );
      },
    inherits(ctor: { prototype: object; super_?: unknown }, superCtor: { prototype: object }) {
      // oxlint-disable-next-line no-underscore-dangle -- Node's name for it.
      ctor.super_ = superCtor;
      Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
    },
    deprecate<T extends (...args: unknown[]) => unknown>(fn: T, message: string, code?: string): T {
      return function (this: unknown, ...args: unknown[]) {
        const key = code ?? message;
        if (!warned.has(key)) {
          warned.add(key);
          warn(`(node) [${code ?? 'DEP0000'}] DeprecationWarning: ${message}\n`);
        }
        return fn.apply(this, args);
      } as T;
    },
    debuglog: () => Object.assign(() => {}, { enabled: false }),
    debug: () => Object.assign(() => {}, { enabled: false }),
    isDeepStrictEqual: (a: unknown, b: unknown) => isDeepStrictEqual(a, b),
    types,
    isArray: Array.isArray,
    isError: (v: unknown) => v instanceof Error,
    isFunction: (v: unknown) => typeof v === 'function',
    isString: (v: unknown) => typeof v === 'string',
    isObject: (v: unknown) => v !== null && typeof v === 'object',
    isPrimitive: (v: unknown) => v === null || (typeof v !== 'object' && typeof v !== 'function'),
    // KEY=value lines (a .env file's), # comments and quotes as Node reads them.
    parseEnv: (content: string) => {
      const out: Record<string, string> = {};
      for (const line of content.split(/\r?\n/)) {
        const match = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (!match) continue;
        let value = match[2];
        const quoted = /^(['"`])([\s\S]*)\1$/.exec(value);
        if (quoted) value = quoted[1] === '"' ? quoted[2].replace(/\\n/g, '\n') : quoted[2];
        else value = value.replace(/\s+#.*$/, '');
        out[match[1]] = value;
      }
      return out;
    },
    parseArgs,
    stripVTControlCharacters: (text: string) =>
      // oxlint-disable-next-line no-control-regex -- ANSI sequences.
      text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''),
    styleText: (style: string | string[], text: string) => {
      const codes: Record<string, [number, number]> = {
        bold: [1, 22],
        dim: [2, 22],
        italic: [3, 23],
        underline: [4, 24],
        red: [31, 39],
        green: [32, 39],
        yellow: [33, 39],
        blue: [34, 39],
        magenta: [35, 39],
        cyan: [36, 39],
        white: [37, 39],
        gray: [90, 39],
        grey: [90, 39],
      };
      for (const name of [style].flat().reverse()) {
        const code = codes[name];
        if (code) text = `\x1b[${code[0]}m${text}\x1b[${code[1]}m`;
      }
      return text;
    },
    toUSVString: (text: string) => text,
    TextEncoder,
    TextDecoder,
  };
}
