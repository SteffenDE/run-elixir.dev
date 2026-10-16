// Tracing for a bug hunt in the browser: localStorage `playground-trace`
// names topics, comma-separated (`net`: the page's connections to its
// nodes and the bridge's requests). Set it, reload, and the console shows
// them. The page's only (workers have no localStorage).
let topics: Set<string> | null = null;

export function tracing(topic: string): boolean {
  if (!topics) {
    try {
      topics = new Set((globalThis.localStorage?.getItem('playground-trace') ?? '').split(','));
    } catch {
      topics = new Set();
    }
  }
  return topics.has(topic);
}

export function trace(topic: string, ...what: unknown[]): void {
  if (tracing(topic))
    console.debug(`[${topic}] ${new Date().toISOString().slice(11, 23)}`, ...what);
}
