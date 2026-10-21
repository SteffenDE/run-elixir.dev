import { posix } from 'node:path';
import { expect, test } from 'vitest';
import { createPath } from '@/runtime/nodejs/path';

const path = createPath(() => '/work');

// Paths whose answers Node's own path gives.
const PATHS = [
  '',
  '/',
  '//',
  '/a//b',
  '//a',
  '/a/b/',
  'a/b//',
  '.',
  '..',
  '...',
  '.js',
  'a..',
  'a.',
  '.a.b',
  'a/.b',
  'a/b.c.d',
  '/a/b.js/',
  '//a//',
  'a/',
  '/a',
  '/..',
  '/a/..',
  '.../',
  '/.',
  'a//b',
  '///a///b///',
];

test.each(['dirname', 'basename', 'extname', 'parse', 'normalize'] as const)('%s as Node', (f) => {
  for (const p of PATHS)
    expect([p, (path[f] as (p: string) => unknown)(p)]).toEqual([
      p,
      (posix[f] as (p: string) => unknown)(p),
    ]);
});

test('basename without a suffix, as Node', () => {
  const cases = [
    ['.js', '.js'],
    ['a.js', '.js'],
    ['aaa/bbb', 'bbb'],
    ['aaa/bbb', 'b'],
    ['/a/b.js/', '.js'],
    ['js', 's'],
  ];
  for (const [p, ext] of cases)
    expect([p, ext, path.basename(p, ext)]).toEqual([p, ext, posix.basename(p, ext)]);
});

test('format as Node', () => {
  const cases = [
    { base: '', name: 'a', ext: '.js' },
    { name: 'a', ext: 'js' },
    { root: '/', name: 'a' },
    { dir: '/x', base: 'b' },
    { root: '/', dir: '/', base: 'b' },
    { dir: 'x', name: 'a', ext: '.js' },
  ];
  for (const parts of cases)
    expect([parts, path.format(parts)]).toEqual([parts, posix.format(parts)]);
});

test('matchesGlob as Node', () => {
  const cases = [
    ['a/b', 'a/**'],
    ['a', 'a/**'],
    ['a/b/c.js', 'a/**/*.js'],
    ['a/c.js', 'a/**/*.js'],
    ['x.js', '[xy].js'],
    ['z.js', '[xy].js'],
    ['z.js', '[!xy].js'],
    ['a.js', '*.{js,ts}'],
    ['a/b', 'a/*'],
    ['a/b/c', 'a/*'],
    ['.a', '*'],
    ['.', '*'],
    ['a/', 'a/**'],
    ['a/.b', 'a/**'],
    ['a/.b', 'a/.*'],
    ['.a/b', '**/b'],
    ['a/b', '**'],
    ['a/x/y/b', 'a/**/b'],
    ['a/b', 'a/**/b'],
    ['ac', 'a{b,{c,d}}'],
    ['ad', 'a{b,{c,d}}e'],
    ['ade', 'a{b,{c,d}}e'],
    ['a{b}', 'a{b}'],
    ['d.js', '[^a-c].js'],
    ['a]', 'a]'],
    ['a[', 'a['],
    ['a/b', 'a/b/'],
    ['a/b/', 'a/b'],
    ['a.b', 'a?b'],
    ['a+b', 'a+b'],
  ];
  for (const [p, glob] of cases)
    expect([p, glob, path.matchesGlob(p, glob)]).toEqual([p, glob, posix.matchesGlob(p, glob)]);
});
