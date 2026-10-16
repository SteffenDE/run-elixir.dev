---
kind: reference
status: live
last_updated: 2026-10-15
---

# Deploying the site

The site is static. A push to the `deploy` branch builds it on a
Forgejo runner and makes it live on the server as a new release
(`.forgejo/workflows/deploy.yml`, `playground/deploy/`):

1. **Build** (`build-site.sh`): the native Rust-OTP install, the NIF
   libraries, then the site, with `PLAYGROUND_DOMAIN` from the
   repository's variables.
2. **Upload** (`upload.sh SITE user@host`): the server seeds
   `releases/RID.partial` with the live release's files, hard-linked, and
   this build's `b/ID/` with the live build's; rsync then sends what
   differs by checksum and deletes what is gone. A changed file is a new
   file (rsync renames it into place), so the live release is never
   written to.
3. **Activate** (`playground-deploy activate RID`, on the server): the
   release must hold the pages, its build's `rotp.wasm`, `worker.js` and
   `fs/`, and a `playground.json` naming `DOMAIN`. It keeps the builds of
   the newest `KEEP_BUILDS` releases (`b/ID/`, for pages loaded before),
   then `current` is pointed at it in one rename. The site is checked as
   served (the isolation headers, the page naming this build, its
   `rotp.wasm` as WebAssembly, `sw.js` no-cache); if that fails, the
   previous release is live again and the deploy fails. Then Cloudflare
   drops its copies of the pages, and releases beyond `KEEP_RELEASES` go.

`playground-deploy rollback` makes the release before the live one live
again; `status` names the live one. Both also work over the deploy key
(`ssh user@host rollback`).

Deploying by hand from a machine with the key is the same:

```sh
PLAYGROUND_DOMAIN=run-elixir.dev playground/deploy/build-site.sh
playground/deploy/upload.sh target/playground/site deploy@server
```

### Setting it up: `setup.sh`

On the production machine (Debian or Ubuntu, with KVM), from a clone of
the repository:

```sh
sudo playground/deploy/setup.sh
```

It asks for the project domain, the site's directory, Forgejo's URL
(from the clone's remote), a runner made in Forgejo (the repository's
Settings → Actions → Runners → Create new runner: its UUID and token) and
the runner VM's size; or takes them from the environment (`DOMAIN`,
`SITE`, `FORGEJO_URL`, `FORGEJO_UUID`, `FORGEJO_TOKEN`,
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
  `runner/provision.sh`: Docker, rustup with the wasm targets, mise with the
  repository's Erlang and Elixir, and forgejo-runner (13.2.0, checked
  against its digest) running as a service as that runner, with the label
  `beamos-build:host`. The VM reaches this machine's sshd at `10.0.2.2`,
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
repository's variable `PLAYGROUND_DOMAIN`.

### The runner elsewhere

Another runner needs the label `beamos-build` with the host executor
(`beamos-build:host`): the build runs Docker itself (`sudo -n docker`, or
`DOCKER`) and needs the repository's toolchain on the runner's user, as
`runner/provision.sh` installs it. It builds in a checkout of its own
that it keeps (`DEPLOY_BUILD_DIR`, default `~/beamos-deploy`), so
`target/` stays warm between deploys. It reaches the server through the
repository's variable `DEPLOY_TARGET` (`deploy@server`) and secrets
`DEPLOY_SSH_KEY` (the private key) and `DEPLOY_KNOWN_HOSTS` (the server's
`ssh-keyscan` line).

### Cloudflare

The pages are HTML and JSON, which Cloudflare does not cache unless told
to, and `sw.js` is no-cache; `b/` and `_playground/` are new names with
each build and cached for good. So nothing needs purging for a deploy to
be seen; the purge of the apex's pages is a safety net for a cache rule
that caches more.

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
  - `_playground/` (the IDE's Vite assets) is content-hashed, and `b/ID/`
    (the runtime's JavaScript, `rotp*.wasm`, `fs/`, `nif/`) is named by a
    digest of its contents ([build.md](build.md#what-the-site-is)): both
    can be cached for good.
  - The pages (`index.html`, `preview.html`, `registry.html`,
    `storage.html`), `sw.js` and `playground.json` keep their names, so they
    should revalidate (ETag or Last-Modified, which Caddy's file_server
    sends). A page names its build, so it never mixes an older build's
    files with a newer one's.
  - Keep the previous build's `b/ID/` for a while after a deploy: a tab
    opened before it keeps loading from there.
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
	header /b/* Cache-Control "public, max-age=31536000, immutable"
	header /sw.js Cache-Control no-cache
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
	# Everything else: files, and the page for every route. (In a handle of
	# its own: try_files, a rewrite, would otherwise run before @hex.)
	handle {
		try_files {path} /index.html
		file_server
	}
}

elixir-playground.steffend.me {
	root * /srv/playground/elixir-playground/current
	import playground
}

# With a project domain (PLAYGROUND_DOMAIN=run-elixir.dev): the same site
# for the apex and every project's origin, one wildcard certificate.
run-elixir.dev, *.run-elixir.dev {
	tls {
		dns PROVIDER {env.DNS_API_TOKEN}
	}
	root * /srv/playground/run-elixir/current
	# The backend (backend.md): NIF builds, and /socket for live sessions.
	@backend path /api/nif/* /socket /socket/*
	handle @backend {
		reverse_proxy 127.0.0.1:4000
	}
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

`python3 -I playground/runtime/serve.py [PORT]` serves
`target/playground/site` with the isolation headers, `no-cache` and the
`index.html` fallback, and proxies `/hex/` as above, and `/api/nif/` to
the backend: production's (run-elixir.dev), or the one `--api URL`
names (`--api http://localhost:4000` for a local `mix phx.server`). It
does not compress. With `--domain playground.localhost:PORT` it answers
`playground.json` with that project domain, whatever the build says:
browsers resolve `*.localhost` to this machine, and with two labels the
apex and its projects are one site (Chromium takes `localhost` for a
top-level domain, so `ID.localhost` would be a site of its own).
