// A module worker from a blob that imports the runtime's script: Firefox
// does not start a worker from a page its service worker controls; a blob
// worker takes the page's cross-origin isolation in both.
export function worker(name: string, base: string): Worker {
  const script = new URL(name, new URL(base, location.href)).href;
  const blob = new Blob([`import ${JSON.stringify(script)};`], { type: 'text/javascript' });
  return new Worker(URL.createObjectURL(blob), { type: 'module' });
}
