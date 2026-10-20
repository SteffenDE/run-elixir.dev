// The cookies a preview's JavaScript may read (not HttpOnly; those stay in
// the bridge's jar). A preview origin is another site's than the page it
// is framed in (site.ts), where browsers keep no cookies of its own
// (WebKit), or only SameSite=None and Secure ones (Chromium): so they are
// kept in the origin's local storage instead (partitioned by the page's
// site, as the preview's is), which its relay (frames/relay.ts) and the
// app's pages share. The pages' document.cookie is this jar
// (cookieShim, which the bridge puts in each).
export const COOKIES = 'playground-cookies';

export type Jar = Record<string, { value: string; expires: number | null }>;

// A Set-Cookie (or document.cookie = …) into the jar: its name and value,
// and when it expires (Max-Age over Expires); the past removes it. Paths and
// domains are not kept (one app, one origin per port). Whole by itself: the
// shim carries its source into the preview's pages.
export function setCookie(jar: Jar, text: string): void {
  const [pair, ...attributes] = text.split(';');
  const at = pair.indexOf('=');
  if (at < 0) return;
  const name = pair.slice(0, at).trim();
  const value = pair.slice(at + 1).trim();
  let maxAge: number | null = null;
  let expires: number | null = null;
  for (const attribute of attributes) {
    const [key, given = ''] = attribute.trim().split('=');
    if (key.toLowerCase() === 'max-age') maxAge = Date.now() + Number(given) * 1000;
    else if (key.toLowerCase() === 'expires') expires = Date.parse(given);
  }
  const until = maxAge ?? expires;
  if (until !== null && !(until > Date.now())) delete jar[name];
  else jar[name] = { value, expires: until };
}

export function readJar(): Jar {
  let jar: Jar = {};
  try {
    jar = JSON.parse(localStorage.getItem(COOKIES) ?? '{}') as Jar;
  } catch {
    // No storage (blocked): no cookies.
  }
  for (const name of Object.keys(jar)) {
    const expires = jar[name].expires;
    if (expires !== null && expires <= Date.now()) delete jar[name];
  }
  return jar;
}

export function writeJar(jar: Jar): void {
  try {
    localStorage.setItem(COOKIES, JSON.stringify(jar));
  } catch {
    // No storage: the cookie is gone with the page.
  }
}

// What document.cookie reads: name=value pairs.
export const cookieString = (jar: Jar) =>
  Object.entries(jar)
    .map(([name, { value }]) => `${name}=${value}`)
    .join('; ');

// In a preview's page (bridge.ts shims), before the app's scripts: its
// document.cookie is the jar. `set` is setCookie, `key` COOKIES.
export function cookieShim(set: (jar: Jar, text: string) => void, key: string) {
  const read = (): Jar => {
    let jar: Jar = {};
    try {
      jar = JSON.parse(localStorage.getItem(key) ?? '{}') as Jar;
    } catch {
      return {};
    }
    for (const name of Object.keys(jar)) {
      const expires = jar[name].expires;
      if (expires !== null && expires <= Date.now()) delete jar[name];
    }
    return jar;
  };
  Object.defineProperty(Document.prototype, 'cookie', {
    configurable: true,
    get: () =>
      Object.entries(read())
        .map(([name, { value }]) => `${name}=${value}`)
        .join('; '),
    set: (text: string) => {
      const jar = read();
      set(jar, String(text));
      try {
        localStorage.setItem(key, JSON.stringify(jar));
      } catch {
        // No storage: the cookie is gone with the page.
      }
    },
  });
}
