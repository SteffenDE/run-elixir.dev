import { describe, expect, it } from 'vitest';
import {
  cloneUrl,
  parseRepository,
  repositoryOfPath,
  repositoryPath,
  webUrl,
} from '@/shared/lib/repository';

describe('parseRepository', () => {
  it('takes the addresses people paste', () => {
    const plain = { host: 'github.com', owner: 'phoenixframework', name: 'phoenix' };
    for (const text of [
      'https://github.com/phoenixframework/phoenix',
      'https://github.com/phoenixframework/phoenix/',
      'https://github.com/phoenixframework/phoenix.git',
      'github.com/phoenixframework/phoenix',
      'https://www.github.com/phoenixframework/phoenix',
      'git@github.com:phoenixframework/phoenix.git',
      'ssh://git@github.com/phoenixframework/phoenix.git',
      ' phoenixframework/phoenix ',
    ])
      expect(parseRepository(text), text).toEqual(plain);
  });

  it('keeps a branch or tag', () => {
    expect(parseRepository('https://github.com/elixir-lang/elixir/tree/v1.18')).toEqual({
      host: 'github.com',
      owner: 'elixir-lang',
      name: 'elixir',
      ref: 'v1.18',
    });
    expect(parseRepository('https://gitlab.com/a/b/-/tree/feature/x')?.ref).toBe('feature/x');
    expect(parseRepository('https://codeberg.org/a/b/src/branch/main')?.ref).toBe('main');
  });

  it('refuses other hosts and other pages', () => {
    for (const text of [
      'https://example.com/a/b',
      'https://github.com/a',
      'https://github.com/a/b/issues/1',
      'https://github.com/a/b?tab=readme',
      'a/b/c',
      'not a url',
      'https://github.com/../b',
    ])
      expect(parseRepository(text), text).toBeNull();
  });
});

describe('the site’s paths', () => {
  it('goes there and back', () => {
    const repository = parseRepository('https://gitlab.com/a/b/-/tree/feature/x')!;
    expect(repositoryPath(repository)).toBe('/gitlab/a/b/tree/feature/x');
    expect(repositoryOfPath('/gitlab/a/b/tree/feature/x')).toEqual(repository);
    expect(repositoryOfPath('/github/a/b')).toEqual({ host: 'github.com', owner: 'a', name: 'b' });
    expect(repositoryOfPath('/github/a')).toBeNull();
    expect(repositoryOfPath('/settings')).toBeNull();
  });

  it('names what git clones and where people look', () => {
    const repository = parseRepository('https://codeberg.org/a/b/src/branch/dev')!;
    expect(cloneUrl(repository)).toBe('https://codeberg.org/a/b.git');
    expect(webUrl(repository)).toBe('https://codeberg.org/a/b/src/branch/dev');
  });
});
