---
kind: reference
status: live
last_updated: 2026-10-28
---

# Deploying the site

The site is static. A push to the `deploy` branch builds it on a
Forgejo runner and makes it live on the server as a new release
(`.forgejo/workflows/deploy.yml`, `deploy/`):

1. **Build** (`build-site.sh`): the NIF libraries, brush, command-line tools,
   Tailscale and TLS WebAssembly modules, then the site with
   the Emscripten BEAM (emsdk 6.0.2 at `~/emsdk`, mise's Erlang 29.1.2 and
   Elixir 1.20.4), with `PLAYGROUND_DOMAIN` and `PLAYGROUND_USERCONTENT`
   from the repository's variables (and `PLAYGROUND_EMBEDDERS`, the other
   sites whose pages may run projects on the usercontent domain:
   [api.md](api.md))).
2. **Upload** (`upload.sh SITE user@host`): the server seeds
   `releases/RID.partial` with the live release's files, hard-linked, and
   each package directory the build names and the live release lacks
   (`npm/@elixir-playground/NAME@VERSION+ID/`, `boot/ID/`) with the live
   one's of the same package (one the live release has already is there as
   it is); rsync then sends what differs by checksum and deletes what is
   gone, but the older packages, recordings and site manifests. A changed file is a new
   file (rsync renames it into place), so the live release is never
   written to.
3. **Activate** (`playground-deploy activate RID`, on the server): the
   release must hold the pages, its runtime package's `worker.js` and
   `exec.html`, its site manifest and every directory that names, and a
   `playground.json` naming `DOMAIN`. It keeps what the newest
   `KEEP_BUILDS` releases run with (their packages, recordings and site
   manifests, for pages loaded before; a release of the layout before
   packages, its `b/ID/` and `r/RID/`), then `current` is pointed at it in
   one rename. The site is checked as served (the isolation headers, the
   page naming this runtime, the pages and `sw.js` no-cache, the site
   manifest and its OTP package's `beam.wasm` immutable, `beam.wasm` as
   WebAssembly, and with a usercontent domain an exec frame's headers
   there and its Node.js worker's `Content-Security-Policy`);
   if that fails, the previous release is live again and the deploy fails.
   Then Cloudflare drops its copies of the apex's pages (if configured), and
   releases beyond `KEEP_RELEASES` go.

`playground-deploy rollback` makes the release before the live one live
again; `status` names the live one. Both also work over the deploy key
(`ssh user@host rollback`).

Deploying by hand from a machine with the key is the same:

```sh
PLAYGROUND_DOMAIN=run-elixir.dev PLAYGROUND_USERCONTENT=run-elixir-usercontent.org deploy/build-site.sh
deploy/upload.sh target/site deploy@server
```

### Setting it up: `setup.sh`

On the production machine (Debian or Ubuntu, with KVM), from a clone of
the repository:

```sh
sudo deploy/setup.sh
```

It asks for the apex, the usercontent domain, the site's directory, Forgejo's URL
(from the clone's remote), a runner made in Forgejo (the repository's
Settings → Actions → Runners → Create new runner: its UUID and token) and
the runner VM's size; or takes them from the environment (`DOMAIN`,
`USERCONTENT`, `SITE`, `FORGEJO_URL`, `FORGEJO_UUID`, `FORGEJO_TOKEN`,
`RUNNER_CPUS`, `RUNNER_MEMORY`, `RUNNER_DISK`, `RUNNER_SSH_PORT`). It
installs what is missing (QEMU, `cloud-localds`, rsync and rrsync), then:

- **The deploy side.** The user `deploy`, `SITE` (`releases/`, and
  `current` once a release is live) owned by it, `playground-deploy` at
  `/usr/local/bin`, and `/etc/playground-deploy.env` (`SITE`, `DOMAIN`;
  add `CF_ZONE_ID` and `CF_API_TOKEN`, a token with Zone → Cache Purge
  only, for the purge; the script's header lists every setting).
- **The deploy key,** made in `/var/lib/playground-runner/deploy_key` and
  in `deploy`'s `authorized_keys` limited to that script, which lets it
  upload into `releases/` (through `rrsync -wo`), prepare, activate, roll
  back and ask, and nothing else:

  ```
  command="/usr/local/bin/playground-deploy",restrict ssh-ed25519 AAAA… playground-runner-deploy
  ```

- **The runner VM,** the systemd service `playground-runner`: QEMU with
  KVM, Ubuntu 24.04's cloud image (checked against its `SHA256SUMS`) under
  a qcow2 disk of `RUNNER_DISK`, and user-mode networking, so the host's
  network is not changed. Its first boot (cloud-init) runs
  `runner/provision.sh`: Docker, emsdk 6.0.2, mise with the
  repository's Erlang and Elixir, and forgejo-runner (13.2.0, checked
  against its digest) running as a service as that runner, with the label
  `run-elixir-build:host`. The VM reaches this machine's sshd at `10.0.2.2`,
  as ssh's host `playground-prod`, with the deploy key and this machine's
  host key. Stopping the service powers the VM off (ACPI).

Run again, it keeps its settings and keys and updates the rest: the
script, the unit, and (over ssh to the running VM) the provisioning. A
`FORGEJO_UUID` and `FORGEJO_TOKEN` given then replace the VM's runner.
The VM's console is `/var/lib/playground-runner/console.log`; its shell:

```sh
sudo ssh -i /var/lib/playground-runner/admin_key -p 2222 runner@127.0.0.1
```

Then point Caddy's `root` at `SITE/current` (below; it resolves the link
on each request, so a release goes live at once and whole), and set the
repository's variables `PLAYGROUND_DOMAIN` and `PLAYGROUND_USERCONTENT`.

### The runner elsewhere

Another runner needs the label `run-elixir-build` with the host executor
(`run-elixir-build:host`): the build runs Docker itself (`sudo -n docker`, or
`DOCKER`) and needs the repository's toolchain on the runner's user, as
`runner/provision.sh` installs it. It builds in a checkout of its own
that it keeps (`DEPLOY_BUILD_DIR`, default `~/run-elixir.dev-deploy`), so
`target/` and `out/` (the BEAM's build, the template) stay warm between
deploys. It reaches the server through the
repository's variable `DEPLOY_TARGET` (`deploy@server`) and secrets
`DEPLOY_SSH_KEY` (the private key) and `DEPLOY_KNOWN_HOSTS` (the server's
`ssh-keyscan` line).

### Cloudflare

HTML pages, `sw.js`, `playground.json` and public assets keep
their names across releases. Serve them with `Cache-Control: no-cache`
and configure the CDN to honor revalidation. A cache rule that overrides
these headers can leave users on an older release.

Files under `npm/`, `boot/`, `site/` and `_playground/` (and `b/` and `r/`,
of releases before the packages) have content-based names and can be
cached as immutable. The optional apex purge uses `CF_ZONE_ID` and
`CF_API_TOKEN`. Usercontent hosts also rely on revalidation: each exec
and preview host has its own cached URLs.

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
- **The proxies refuse other sites' pages** (`Sec-Fetch-Site:
  cross-site`, [api.md](api.md#who-may-run-projects-on-a-usercontent-domain)).
- **git clones at `/git/`.** Git dependencies are fetched by the page
  over git's smart HTTP, which GitHub, GitLab and Codeberg serve without
  CORS headers; the site proxies cloning and fetching only (no pushes).
- **The page for every route.** `/`, `/phoenix`, `/empty`, `/iex` and each
  project's `/ID/` are all `index.html`: a path that is no file gets it.
- **The service worker at the site's root.** `/sw.js` controls the scope
  `/`. Serve it with `Cache-Control: no-cache`, so that an update reaches
  browsers.
- **Compression.** `beam.wasm`, the JavaScript and the bundles (`.tar`,
  uncompressed on purpose: the node reads them synchronously) should be
  compressed in transit. The boot images (`boot/ID/*.tar.gz`) are gzipped already. Caddy does not
  compress `application/x-tar` or `application/wasm` by default.
- **Caching.**
  - `_playground/` (the IDE's Vite assets) is content-hashed; the packages
    (`npm/`), the recordings (`boot/`) and the site manifests (`site/`) are named by digests of their contents
    ([build.md](build.md#what-the-site-is)): all can be cached for good,
    and a deploy of JavaScript alone keeps the other packages' names.
  - The pages (`index.html`, `preview.html`, `storage.html`),
    `sw.js`, `playground.json` and `app/public`'s files
    (`favicon.ico`, `icons/`, `manifest.webmanifest`, `og.png`) keep their
    names, so they are served `Cache-Control: no-cache`: they revalidate
    (ETag or Last-Modified, which Caddy's file_server sends) at the
    browser and at Cloudflare. A page names its runtime package and site
    manifest, so it never mixes an older build's files with a newer one's.
  - Keep the previous builds' packages for a while after a deploy: a tab
    opened before it keeps loading from them.
- **Projects outlive deploys.** They are kept in the browser, over the
  template of the site that made them; a build whose fs layers' files
  differ (the template's, OTP's, Elixir's: their `version`s in the site
  manifest) changes what they were made over, and a project's next start
  drops its template build records
  ([projects.md](projects.md#what-is-kept)).

## The two domains

The site has two (`PLAYGROUND_DOMAIN` and `PLAYGROUND_USERCONTENT` when
building, written to `playground.json`; [frames.md](frames.md)):

- **The apex** (run-elixir.dev): every page, cross-origin isolated (COOP
  `same-origin`, COEP `require-corp`), each response with
  `Cross-Origin-Resource-Policy: same-site`. Its subdomains stay served
  for the former layout's addresses (`p-ID`, `l-ID`), which send their
  visitors to the apex, and whose `storage.html` moves a project's
  stores to it ([frames.md](frames.md#moving-the-former-layouts-stores));
  they can go once those have moved.
- **The usercontent domain** (run-elixir-usercontent.org), another
  registrable domain (so another
  site: none of the apex's cookies, its own processes): `e-ID` (a
  project's exec frame), `v-ID-PORT` (its preview) and `claude` (package
  preparation), every response with
  COEP `require-corp` and `Cross-Origin-Resource-Policy: cross-origin`,
  for the apex's pages to frame. The same files; the Hex and git proxies
  and `/api/v1/nif/`, which the exec frame's nodes and programs request from
  their own origin, plus `/relay` for TCP relay connections. Live sessions
  use `/socket` on the apex.

Both need wildcard certificates, and so DNS challenges: a Caddy built
with its DNS provider's module (`xcaddy build --with
github.com/caddy-dns/PROVIDER`). A site without the usercontent domain
starts no project: its pages say so.

## Caddy

```caddy
# The apex's headers, and the usercontent domain's (frames.md).
(apex) {
	header {
		Cross-Origin-Opener-Policy same-origin
		Cross-Origin-Embedder-Policy require-corp
	}
	header Cross-Origin-Resource-Policy same-site
}
(usercontent) {
	header {
		Cross-Origin-Embedder-Policy require-corp
		Cross-Origin-Resource-Policy cross-origin
	}
	# A Node.js process's worker and its chunks (nodejs.md, The worker's
	# policy): its own scripts and the packages' files, no other network.
	# serve.py sends the same.
	@nodejs path_regexp nodejs ^(/npm/@elixir-playground/runtime@[^/]+)/(nodejs\.js|chunks/[^/]+\.js)$
	header @nodejs Content-Security-Policy "default-src 'none'; script-src https://{host}{re.nodejs.1}/nodejs.js https://{host}{re.nodejs.1}/chunks/ 'unsafe-eval' 'wasm-unsafe-eval'; worker-src https://{host}{re.nodejs.1}/nodejs.js https://{host}{re.nodejs.1}/chunks/ blob:; connect-src https://{host}/npm/@elixir-playground/ data: blob:"
}

# The proxies answer the site's own pages and frames, not another site's
# (api.md: no boundary for other clients). Imported first in each site:
# handle blocks are tried in the order they appear (and a bare respond
# would run after them all).
(proxies) {
	@crosssite {
		path /hex/* /git/* /api/v1/nif/*
		header Sec-Fetch-Site cross-site
	}
	handle @crosssite {
		respond 403
	}
}

(playground) {
	# New names when their contents change: for good. Everything else (the
	# pages, sw.js, playground.json, every route's index.html) keeps its
	# name: revalidated each time, at the browser and at Cloudflare, so a
	# deploy needs no purge.
	@versioned path /_playground/* /npm/* /boot/* /site/* /b/* /r/*
	header @versioned Cache-Control "public, max-age=31536000, immutable"
	@named not path /_playground/* /npm/* /boot/* /site/* /b/* /r/*
	header @named Cache-Control no-cache
	# Never application/gzip: PGlite takes a gzip Content-Encoding for its
	# extension archives' own gzip and does not unpack them ("File is
	# corrupted"), and a cache keeps such a response until purged.
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
	# Everything else: files, a directory's index.html (/licenses/), and
	# the page for every route. (In a handle of its own: try_files, a
	# rewrite, would otherwise run before @hex.)
	handle {
		try_files {path} {path}/index.html /index.html
		file_server
	}
}

# Without a usercontent domain it starts no project (frames.md).
elixir-playground.steffend.me {
	root * /srv/playground/elixir-playground/current
	import proxies
	import apex
	import playground
}

# The apex (PLAYGROUND_DOMAIN=run-elixir.dev), and the former layout's
# subdomains (p-ID, l-ID), one wildcard certificate.
run-elixir.dev, *.run-elixir.dev {
	tls {
		dns PROVIDER {env.DNS_API_TOKEN}
	}
	root * /srv/playground/run-elixir/current
	import proxies
	# The backend (backend.md): NIF builds, and /socket for live sessions.
	@backend path /api/v1/nif/* /socket /socket/*
	handle @backend {
		reverse_proxy 127.0.0.1:4000
	}
	import apex
	import playground
}

# The usercontent domain (PLAYGROUND_USERCONTENT=run-elixir-usercontent.org):
# projects' exec frames
# and previews, the same files, framed by the apex from another site.
*.run-elixir-usercontent.org {
	tls {
		dns PROVIDER {env.DNS_API_TOKEN}
	}
	root * /srv/playground/run-elixir/current
	import proxies
	# NIF builds, which the exec frame's nodes fetch from their origin,
	# and the TCP relay its gateway opens (relay.md).
	@backend path /api/v1/nif/* /relay
	handle @backend {
		reverse_proxy 127.0.0.1:4000
	}
	import usercontent
	import playground
}

# The backend's admin.
run-elixir.steffend.me {
	reverse_proxy 127.0.0.1:4000
	log {
		output file /var/log/caddy/run-elixir-admin.log
	}
}

# The former Phoenix playground: a new Phoenix project.
phoenix-playground.steffend.me {
	redir https://elixir-playground.steffend.me/phoenix
}
```

## Locally

For a local build, run:

```sh
python3 -I runtime/serve.py 8081 \
  --domain playground.localhost:8081 --usercontent usercontent.localhost:8081
```

Open `http://playground.localhost:8081`. The server serves
`target/site` with the isolation headers, `no-cache` and the
`index.html` fallback, and proxies `/hex/` as above, and `/api/v1/nif/` to
the backend: production's (run-elixir.dev), or the one `--api URL`
names (`--api http://localhost:4000` for a local `mix phx.server`). It
does not compress. With `--domain playground.localhost:PORT --usercontent
usercontent.localhost:PORT` it answers `playground.json` with the two
domains, whatever the build says, and the usercontent domain's hosts
with its headers: browsers resolve `*.localhost` to this machine, and
with two labels each is a site of its own (Chromium takes `localhost` for
a top-level domain). `--embedders "ORIGIN …"` names the other sites
whose pages may run projects on the usercontent domain instead of the
build's, and `--embedder-host HOST --embedder-root DIR` serves a test
embedder's page there, cross-origin isolated, with the site's packages
as its install ([api.md](api.md#tests)).
