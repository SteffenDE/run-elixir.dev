---
kind: reference
status: live
last_updated: 2026-10-13
---

# Deploying the site

The site is static. Build it, then copy `target/playground/site/` to the
server:

```sh
python3 -I playground/runtime/build.py
rsync -a --delete target/playground/site/ server:/srv/elixir-playground/
```

## What the server must do

- **Cross-origin isolation, on every response.** Nodes share memory with the
  page (SharedArrayBuffer), which needs `Cross-Origin-Opener-Policy:
  same-origin` and `Cross-Origin-Embedder-Policy: credentialless` (or
  `require-corp`). Without them the page says so and starts nothing.
  The preview's own responses come from the service worker, which adds what
  they need.
- **The page for every route.** `/`, `/phoenix`, `/empty`, `/iex` and each
  project's `/ID/` are all `index.html`: a path that is no file gets it.
- **The service worker at the site's root.** `/sw.js` controls the scope
  `/`. Serve it with `Cache-Control: no-cache`, so that an update reaches
  browsers.
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
- **Projects outlive deploys.** They are kept in the browser, over the
  template of the site that made them; a new build changes `fs/version`,
  and a project's next start drops its template build records
  ([projects.md](projects.md#what-is-kept)).

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
	try_files {path} /index.html
	file_server
}

elixir-playground.steffend.me {
	root * /srv/elixir-playground
	import playground
}

# The former Phoenix playground: a new Phoenix project.
phoenix-playground.steffend.me {
	redir https://elixir-playground.steffend.me/phoenix
}
```

## Locally

`python3 -I playground/runtime/serve.py [PORT]` serves
`target/playground/site` with the isolation headers, `no-cache` and the
`index.html` fallback. It does not compress.
