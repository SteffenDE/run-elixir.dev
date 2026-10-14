---
kind: reference
status: live
last_updated: 2026-10-14
---

# Deploying the site

The site is static. Build it, then copy `target/playground/site/` to the
server:

```sh
PLAYGROUND_DOMAIN=run-elixir.dev python3 -I playground/runtime/build.py
rsync -a --delete target/playground/site/ server:/srv/elixir-playground/
```

## What the server must do

- **Cross-origin isolation, on every response.** Nodes share memory with the
  page (SharedArrayBuffer), which needs `Cross-Origin-Opener-Policy:
  same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Without
  them the page says so and starts nothing. Not `credentialless`: WebKit
  (Safari) does not take it, and its page is then not isolated. So an app
  in the preview loads another site's images, scripts or styles only when
  that site sends CORS or `Cross-Origin-Resource-Policy: cross-origin`.
  The preview's own responses come from the service worker, which adds what
  they need.
- **Hex's repository at `/hex/`.** repo.hex.pm sends no CORS headers, so
  the page fetches Hex's registry and tarballs through the site
  ([architecture.md](architecture.md#hex)). Only what Hex fetches is
  proxied. Without it, the page falls back to a public mirror that sends
  CORS headers (hexpm.upyun.com, slower).
- **git clones at `/git/`.** Git dependencies are fetched by the page
  over git's smart HTTP, which GitHub, GitLab and Codeberg serve without
  CORS headers; the site proxies cloning and fetching only (no pushes).
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

## A project domain

With `PLAYGROUND_DOMAIN` set when building (written to
`playground.json`), each project runs on its own origin, `p-ID.DOMAIN`, and
the domain itself has the projects' list
([projects.md](projects.md#a-project-domain)). The server then serves
the same site for `DOMAIN` and `*.DOMAIN`, which needs a wildcard
certificate, and so a DNS challenge: a Caddy built with its DNS
provider's module (`xcaddy build --with github.com/caddy-dns/PROVIDER`).
Every response also carries `Cross-Origin-Resource-Policy: same-site`:
the apex and a project's origin frame each other's pages (`registry.html`,
`storage.html`), which `require-corp` lets in only so. Without
`PLAYGROUND_DOMAIN`, a project is a path (`/ID/`) on one origin.

## Caddy

```caddy
(playground) {
	header {
		Cross-Origin-Opener-Policy same-origin
		Cross-Origin-Embedder-Policy require-corp
		Cross-Origin-Resource-Policy same-site
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
	# Hex's repository, for the page (repo.hex.pm sends no CORS headers).
	@hex path_regexp hex ^/hex/(names|versions|public_key|(packages|tarballs)/[A-Za-z0-9_.+-]+)$
	handle @hex {
		uri strip_prefix /hex
		reverse_proxy https://repo.hex.pm {
			header_up Host repo.hex.pm
		}
	}
	# git's smart HTTP, for cloning and fetching only (GitHub, GitLab and
	# Codeberg send no CORS headers): /git/HOST/OWNER/REPO/...
	@git path_regexp git ^/git/(github\.com|gitlab\.com|codeberg\.org)(/[\w.-]+/[\w.-]+/(info/refs|git-upload-pack))$
	handle @git {
		@clone expression `({method} == "GET" && {re.git.3} == "info/refs" && {query} == "service=git-upload-pack") || ({method} == "POST" && {re.git.3} == "git-upload-pack")`
		handle @clone {
			rewrite * {re.git.2}?{query}
			# A placeholder upstream takes no scheme: TLS by transport.
			reverse_proxy {re.git.1}:443 {
				header_up Host {re.git.1}
				transport http {
					tls
					tls_server_name {re.git.1}
				}
			}
		}
		respond 403
	}
	# Everything else: files, and the page for every route. (In a handle of
	# its own: try_files, a rewrite, would otherwise run before @hex.)
	handle {
		try_files {path} /index.html
		file_server
	}
}

elixir-playground.steffend.me {
	root * /srv/elixir-playground
	import playground
}

# With a project domain (PLAYGROUND_DOMAIN=run-elixir.dev): the same site
# for the apex and every project's origin, one wildcard certificate.
run-elixir.dev, *.run-elixir.dev {
	tls {
		dns PROVIDER {env.DNS_API_TOKEN}
	}
	root * /srv/run-elixir
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
`index.html` fallback, and proxies `/hex/` as above. It does not
compress. With `--domain playground.localhost:PORT` it answers
`playground.json` with that project domain, whatever the build says:
browsers resolve `*.localhost` to this machine, and with two labels the
apex and its projects are one site (Chromium takes `localhost` for a
top-level domain, so `ID.localhost` would be a site of its own).
