import { expect, test } from 'vitest';
import { sharedRecords } from '@/runtime/overlay';

test('only canonical /shared paths with valid records may cross project boundaries', () => {
  const file = { path: '/shared/config/token', kind: 'file', data: new Uint8Array(), mtime: '0' };
  expect(sharedRecords([file])).toBe(true);
  for (const path of [
    '/work/foreign',
    '/home/user/token',
    '/shared',
    '/shared/../work/foreign',
    '/shared//foreign',
    '/shared/./foreign',
    '/shared/nul\0',
  ]) {
    expect(sharedRecords([{ ...file, path }])).toBe(false);
  }
  for (const invalid of [
    null,
    {},
    [null],
    [{ ...file, kind: 'unknown' }],
    [{ ...file, data: 'bad' }],
    [{ ...file, mtime: 'bad' }],
  ]) {
    expect(sharedRecords(invalid)).toBe(false);
  }
});
