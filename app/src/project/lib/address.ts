// The preview's address as the app sees it: localhost:PORT/path. The
// preview shows one of the app's ports at a time; a path on another port
// goes through the bridge's switch to it (runtime/bridge.ts, SWITCH).

// The path the preview goes to for `path` on `port`, while it shows
// `current`.
export function previewPath(port: number | null, path: string, current: number | null): string {
  return port === null || port === current ? path : `/__playground/port/${port}${path}`;
}

// What the path bar shows, without the scheme (localhost:4000/users).
export function shownAddress(port: number | null, path: string): string {
  return port === null ? path : `localhost:${port}${path}`;
}

// Where what is typed into the path bar goes: a path, on this port, or
// the app's URL (as it prints it, http://localhost:4000/…).
export function typedPath(typed: string, current: number | null): string {
  const text = typed.trim();
  const app = text.match(
    /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d+))?(\/.*)?$/i,
  );
  if (!app) return text.startsWith('/') ? text : `/${text}`;
  return previewPath(app[1] ? Number(app[1]) : current, app[2] ?? '/', current);
}
