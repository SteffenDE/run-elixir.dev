// Node's Buffer: the buffer package's, with what it lacks of Node's own,
// the base64url encoding (as base64 with - and _, unpadded).
import { Buffer } from 'buffer';

const toBase64 = (text: string) => text.replace(/-/g, '+').replace(/_/g, '/');
const toUrl = (text: string) => text.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const url = (encoding: unknown) =>
  typeof encoding === 'string' && encoding.toLowerCase() === 'base64url';

type Method = (...args: unknown[]) => unknown;
const proto = Buffer.prototype as unknown as { toString: Method; write: Method };
const toString = proto.toString;
proto.toString = function (this: Buffer, encoding?: unknown, ...rest: unknown[]) {
  return url(encoding)
    ? toUrl(toString.apply(this, ['base64', ...rest]) as string)
    : toString.apply(this, [encoding, ...rest]);
};
const write = proto.write;
proto.write = function (this: Buffer, text: unknown, ...rest: unknown[]) {
  const at = rest.findIndex(url);
  if (at === -1) return write.apply(this, [text, ...rest]);
  rest[at] = 'base64';
  return write.apply(this, [toBase64(String(text)), ...rest]);
};

const statics = Buffer as unknown as Record<string, (...args: unknown[]) => unknown>;
const from = statics.from;
statics.from = function (value: unknown, encoding?: unknown, ...rest: unknown[]) {
  if (typeof value === 'string' && url(encoding))
    return from.call(Buffer, toBase64(value), 'base64');
  return from.apply(Buffer, [value, encoding, ...rest]);
};
const byteLength = statics.byteLength;
statics.byteLength = function (value: unknown, encoding?: unknown) {
  if (typeof value === 'string' && url(encoding))
    return byteLength.call(Buffer, toBase64(value), 'base64');
  return byteLength.call(Buffer, value, encoding);
};
const isEncoding = statics.isEncoding;
statics.isEncoding = (encoding: unknown) =>
  url(encoding) || (isEncoding.call(Buffer, encoding) as boolean);

export { Buffer };
