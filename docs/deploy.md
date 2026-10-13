---
kind: reference
status: live
last_updated: 2026-10-13
---

# Deploying a site

A site is static. Build it, then copy `target/playground/SITE/` to the
server:

```sh
python3 -I playground/runtime/build.py phoenix
rsync -a --delete target/playground/phoenix/ server:/srv/phoenix-playground/
```

## What the server must do

- **Cross-origin isolation, on every response.** Nodes share memory with the
  page (SharedArrayBuffer), which needs `Cross-Origin-Opener-Policy:
  same-origin` and `Cross-Origin-Embedder-Policy: credentialless` (or
  `require-corp`). Without them the page says so and starts nothing.
  The preview's own responses come from the service worker, which adds what
  they need.
- **The service worker at the site's root.** `sw.js` must be served from
  the directory of `index.html`, which is the scope it controls. Serve it
  with `Cache-Control: no-cache`, so that an update reaches browsers.
- **Compression.** `rotp.wasm`, the JavaScript and the bundles (`.tar`,
  uncompressed on purpose: the node reads them synchronously) should be
  compressed in transit. `fs/boot.tar.gz` is gzipped already. Caddy does not
  compress `application/x-tar` or `application/wasm` by default.
- **Caching.**
  - `_playground/` (the IDE's Vite assets) is content-hashed and can be
    cached for good.
  - `rotp.wasm`, `fs/`, the runtime's `*.js` and `index.html` keep their
    names across builds, so they should revalidate (ETag or Last-Modified,
    which Caddy's file_server sends). Otherwise a browser may mix an old
    `rotp.wasm` with a new filesystem.

## Caddy

```caddy
(playground) {
	header {
		Cross-Origin-Opener-Policy same-origin
		Cross-Origin-Embedder-Policy credentialless
	}
	header /_playground/* Cache-Control "public, max-age=31536000, immutable"
	header /sw.js Cache-Control no-cache
	encode zstd gzip {
		match {
			header Content-Type text/*
			header Content-Type application/javascript*
			header Content-Type application/json*
			header Content-Type application/wasm
			header Content-Type application/x-tar
		}
	}
	file_server
}

elixir-playground.steffend.me {
	root * /srv/elixir-playground
	import playground
}

phoenix-playground.steffend.me {
	root * /srv/phoenix-playground
	import playground
}
```

## Locally

`python3 -I playground/runtime/serve.py SITE [PORT]` serves
`target/playground/SITE` with the isolation headers and `no-cache`. It does
not compress.
