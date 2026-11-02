import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { entries } from '@elixir-playground/runtime/wasi/fs';
import { DEFAULT, parseBuild } from '../src/builds';
import { described } from '../src/elixir';
import { MTIME, writeLayer } from '../src/layer';
import { unzip } from '../src/zip';

describe('builds', () => {
  it('names Elixir and the OTP major', () => {
    expect(parseBuild('1.20.4-otp-29')).toEqual({ elixir: '1.20.4', otp: 29 });
    expect(parseBuild('1.20.0-rc.0-otp-27')).toEqual({ elixir: '1.20.0-rc.0', otp: 27 });
    expect(() => parseBuild('1.20.4')).toThrow(/not a precompiled Elixir build/);
  });

  it('describes a build for create()', () => {
    const descriptor = {
      name: '@elixir-playground/elixir',
      version: '3.0.0',
      base: '/npm/@elixir-playground/elixir@3.0.0/',
      files: {},
      playground: { bin: { mix: 'bin/mix' } },
    };
    expect(described(descriptor, '1.19.5-otp-28').playground).toEqual({
      bin: { mix: 'bin/mix' },
      elixir: '1.19.5',
      requires: { otp: '^28.0.0' },
      layer: 'versions/1.19.5-otp-28/fs.json',
    });
    expect(described(descriptor).playground.layer).toBe(`versions/${DEFAULT}/fs.json`);
  });
});

// A zip of `files`, the first stored, the others deflated, each with a
// Unix mode.
function zip(files: { name: string; data: Uint8Array; mode: number }[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  files.forEach(({ name, data, mode }, i) => {
    const method = i === 0 ? 0 : 8;
    const body = method ? new Uint8Array(deflateRawSync(data)) : data;
    const named = new TextEncoder().encode(name);
    const local = new Uint8Array(30 + named.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, named.length, true);
    local.set(named, 30);
    const entry = new Uint8Array(46 + named.length);
    const cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, named.length, true);
    cv.setUint32(38, mode << 16, true);
    cv.setUint32(42, offset, true);
    entry.set(named, 46);
    locals.push(local, body);
    central.push(entry);
    offset += local.length + body.length;
  });
  const size = central.reduce((n, part) => n + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...central, end];
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe('unzip', () => {
  it('reads stored and deflated files with their modes', () => {
    const text = (s: string) => new TextEncoder().encode(s);
    const read = unzip(
      zip([
        { name: 'bin/mix', data: text('#!/usr/bin/env elixir\n'), mode: 0o100755 },
        {
          name: 'lib/elixir/ebin/elixir.app',
          data: text('{application, elixir}.'.repeat(50)),
          mode: 0o100644,
        },
      ]),
    );
    expect(read.map(({ name, mode }) => [name, mode & 0o777])).toEqual([
      ['bin/mix', 0o755],
      ['lib/elixir/ebin/elixir.app', 0o644],
    ]);
    expect(new TextDecoder().decode(read[1].data)).toBe('{application, elixir}.'.repeat(50));
  });
});

describe('writeLayer', () => {
  let directory = '';
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('writes bundles the runtime reads, one directory each', () => {
    directory = mkdtempSync(join(tmpdir(), 'layer-'));
    const long = `lib/mix/ebin/${'Elixir.Mix.Tasks.'.repeat(4)}beam`;
    const layer = writeLayer(
      directory,
      [
        { path: 'bin/mix', data: new Uint8Array([1, 2, 3]), executable: true },
        { path: long, data: new Uint8Array(700) },
        { path: 'lib/mix/ebin/mix.app', data: new Uint8Array(10) },
      ],
      '/opt/elixir/1.20.4',
    );
    expect(layer).toMatchObject({ format: 3, root: '/opt/elixir/1.20.4', count: 2 });
    const manifest = JSON.parse(readFileSync(join(directory, 'fs', 'manifest.json'), 'utf8'));
    expect(manifest).toEqual([
      ['bin/mix', 3, MTIME, 0],
      [long, 700, MTIME, 1],
      ['lib/mix/ebin/mix.app', 10, MTIME, 1],
    ]);
    const read = [
      ...entries(new Uint8Array(readFileSync(join(directory, 'fs', 'bundles', '1.tar')))),
    ];
    expect(read.map(({ name, body }) => [name, body.length])).toEqual([
      [`opt/elixir/1.20.4/${long}`, 700],
      ['opt/elixir/1.20.4/lib/mix/ebin/mix.app', 10],
    ]);
    expect(read[0].mtime).toBe(BigInt(MTIME) * 1000000000n);
  });
});
