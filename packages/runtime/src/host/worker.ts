import { bridgeKey } from '../lib/apexLink';

// A module worker from a blob that imports the runtime's script: Firefox
// does not start a worker from a page its service worker controls; a blob
// worker takes the page's cross-origin isolation in both. In bridge mode
// (docs/frames.md) the script is the service worker's to answer, and
// Firefox does not let a blob worker that a worker starts be controlled
// by it: the worker starts from its script's URL instead.
export function worker(name: string, base: string): Worker {
  const script = new URL(name, new URL(base, location.href)).href;
  if (bridgeKey()) return new Worker(script, { type: 'module' });
  const blob = new Blob([`import ${JSON.stringify(script)};`], { type: 'text/javascript' });
  return new Worker(URL.createObjectURL(blob), { type: 'module' });
}
