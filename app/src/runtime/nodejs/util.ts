// Node's util: format and inspect as console.log prints values, and the
// helpers packages use (promisify, inherits, deprecate, types, …).
import { Buffer } from 'buffer';

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
    if (typeof object[custom] === 'function')
      return String(
        (object[custom] as (d: number, o: unknown, i: unknown) => unknown)(
          depth - level,
          options,
          inspect,
        ),
      );
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
        const items = v.slice(0, 100).map((item) => show(item, level + 1, true));
        if (v.length > 100) items.push(`... ${v.length - 100} more items`);
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
          return typeof value === 'string'
            ? value
            : typeof value === 'bigint'
              ? `${value}n`
              : typeof value === 'object' && value !== null
                ? inspect(value, { ...options, depth: 1 })
                : String(value);
        case 'd':
          return typeof value === 'bigint' ? `${value}n` : String(Number(value));
        case 'i':
          return typeof value === 'bigint' ? `${value}n` : String(parseInt(String(value), 10));
        case 'f':
          return String(parseFloat(String(value)));
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
      fn.call(this, ...args, (error: unknown, ...values: unknown[]) =>
        error ? reject(error) : resolve(values.length > 1 ? values : values[0]),
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

export function isDeepStrictEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (a instanceof Date) return a.getTime() === (b as Date).getTime();
  if (a instanceof Map) {
    const other = b as Map<unknown, unknown>;
    return (
      a.size === other.size &&
      [...a].every(([k, v]) => other.has(k) && isDeepStrictEqual(v, other.get(k)))
    );
  }
  if (a instanceof Set) {
    const other = b as Set<unknown>;
    return a.size === other.size && [...a].every((v) => other.has(v));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    isDeepStrictEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
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
    isDeepStrictEqual,
    types,
    isArray: Array.isArray,
    isError: (v: unknown) => v instanceof Error,
    isFunction: (v: unknown) => typeof v === 'function',
    isString: (v: unknown) => typeof v === 'string',
    isObject: (v: unknown) => v !== null && typeof v === 'object',
    isPrimitive: (v: unknown) => v === null || (typeof v !== 'object' && typeof v !== 'function'),
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
