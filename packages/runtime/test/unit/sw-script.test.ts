// The service worker's script stamp (src/swScript.ts): what the build
// appends to sw.js, and the hash the bootstrap compares with the worker's.
import { expect, it } from 'vitest';
import { STAMP, scriptHash, sha256, stamp } from '../../src/swScript';

it('stamps a script with the hash of what is before the stamp', async () => {
  const code = 'var a=1;self.addEventListener("fetch",()=>{});';
  const stamped = await stamp(code);
  expect(stamped.startsWith(code)).toBe(true);
  expect(stamped.match(STAMP)?.[1]).toBe(await sha256(code));
  // The stamped script as a server sends it hashes to its stamp.
  expect(await scriptHash(stamped)).toBe(await sha256(code));
  // A line after it, or a change before it, is another script.
  expect(await scriptHash(`${stamped}// revision 1\n`)).not.toBe(await sha256(code));
  expect(await scriptHash(stamped.replace('a=1', 'a=2'))).not.toBe(await sha256(code));
});
