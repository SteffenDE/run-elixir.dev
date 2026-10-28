---
kind: reference
status: prototype
last_updated: 2026-10-28
---

# Licenses

The playground's own code is under the Apache License 2.0 (`LICENSE`,
`NOTICE`). `tools/wasi-compat/` is MIT, because GPL-2.0 git links it and
Apache-2.0 is not GPL-2.0-compatible. Patches to third-party code
(`beam/patches/`, `brush/patches/`, `tools/*/patches/`) are under the
license of the code they patch.

What the site serves bundles third-party software. Every build records
what each package contains and under which license. It writes those
records into the packages and onto the site's `/licenses/` page. A
build fails when a component's license is unknown or missing a text, or
when a copyleft component's source is not in its package.

As of 2026-10-28 this exists on the `sd-packages` branch only. It is not
deployed, and nothing is published to npm.

## What a package carries

Each package directory (`npm/@elixir-playground/NAME@VERSION+ID/`) has:

- **`package.json` `license`:** an SPDX expression, the conjunction of its
  components' licenses (each once, sorted).
- **`NOTICE.md`:** the expression and a table of the components (name,
  version, license, source).
- **`licenses/`:** `index.json` (format 1: each component's `name`,
  `version`, `license`, `url`, `texts`, and `source` and `note` when
  there are any) and each component's license files in `NAME-VERSION/`.
- **`LICENSE`:** the Apache-2.0 text, in the packages with the
  playground's own code in them (`runtime`, `api`, `claude`, `otp-X`,
  `tls`, `tailscale`).
- **`source/`:** the corresponding source of the components whose
  license asks for it to go with the binary. Today: `git` (git 2.56.0 and
  zlib, 9.7 MB) and `gnu-tools` (sed, grep, diffutils, gawk and findutils,
  12 MB). Each `source/TOOL/` has the release tarball, its patches, its
  build script, `tools/wasi-compat/` and a README. The site serves these
  files from the same place as the binaries, as GPL-2.0 §3 asks.

The `tls` package's Mozilla CA bundle (`roots.pem`) is MPL-2.0. The file
is its own source form.

## Where each inventory comes from

| Package | Inventory |
| --- | --- |
| `runtime`, `api` | The playground; what their Vite builds bundled from `node_modules` (`vite-licenses.ts` → `dist-licenses/*.json`, at the root). |
| `otp-X` | Erlang/OTP; OTP's vendored zlib, pcre2, ryu and Unicode data (its `vendor.info` files); Popcorn's patches; OpenSSL and ncurses; Emscripten, its musl and compiler-rt; the playground's patches and host code. |
| `elixir-X` | Elixir (its release's `LICENSE` and `LICENSES/`), Hex, phx_new, rebar3 and the 10 applications rebar3 vendors. |
| `phoenix-template` | The phx.new app, topbar, and each dependency: Hex metadata and license files, or (git dependencies) the `LICENSE` at the locked commit. |
| `shell`, `ripgrep`, `tls` | The crates the module links (`cargo tree` for wasm32-wasip1, normal dependencies, no proc macros), Rust's standard library and wasi-libc. `shell` also has ncurses's terminfo entry. |
| `tailscale` | The Go modules it compiles (`go list -deps` with its tags), Go's standard library (and `wasm_exec.js`), and the playground. |
| `git`, `gnu-tools` | Each tool's release (its `COPYING`), zlib for git, wasi-libc and wasi-compat. |
| `claude` | The playground only: Claude Code comes from npm in the browser, and the site never serves it. |

Each tool's build writes its inventory (`tools/licenses.py`) next to its
module: `target/NAME/licenses/` and, for a GPL tool, `target/NAME/source/`.
A stamp holds the build's own stamp and `tools/licenses.py`'s digest.
`runtime/notices.py` assembles the packages. The OTP, Elixir and template
inventories need a full build. `build.py app` reuses those packages'
`licenses/`, and works them out again for a site from before licenses.
Release tarballs and license files fetched by URL are kept in
`target/cache-otp/licenses/`.

A component that declares a license but ships no license file gets the
SPDX standard text (`tools/license-texts/spdx/`) and a note that says so.
Several Hex packages in the template ship none, nor does Hex's
repository.

## The allowed licenses

`tools/licenses.py` lists them:

- **Permissive:** MIT, MIT-0, Apache-2.0, ISC, the BSD licenses, 0BSD,
  Zlib, Unlicense, CC0-1.0, BSL-1.0, the Unicode licenses,
  CDLA-Permissive-2.0, NCSA, ncurses's X11 variant, and Elixir's
  `LicenseRef-scancode-unicode`.
- **Copyleft:** GPL, LGPL and MPL-2.0. A component under one of these
  (with no permissive choice in its expression) must name its source.
- **Other:** `LicenseRef-Remix-Icon-1.0`, Remix Icon's license
  (`@remixicon/react`, the IDE's icons). It allows icons inside a larger
  product, which is how the IDE uses them. It does not allow selling them
  as an icon set or using them as a logo. It is not an open-source
  license, so the IDE's bundle is not entirely open source.

Any other license stops the build until someone has read it and added it.

## The licenses page (`/licenses/`)

`build.py` writes `licenses/index.html` after it prunes the site. The
page lists the IDE's bundle first (its texts in `licenses/apex/`), then
every package the site has. Each row links to the component's license
texts and, where there is one, its source, all at the package's
immutable paths. The page lists what this deploy serves and nothing
else. The home page links to it. `playground-deploy` refuses a release
without it. Caddy serves it like the other pages, revalidated on each
request.

## Tests

`python3 -I tests/licenses.py` covers SPDX parsing and normalization, the
copyleft rule, the text classifier, the checks, and a package's notices.
It runs in CI (`app.yml`, job `licenses`). `site.yml` caches and passes
on each tool's `licenses/` and `source/` with its module.

## Not covered

- **NIF libraries the backend builds** from Hex packages on request
  ([nif.md](nif.md)). An archive holds only the package's `priv/` files.
  The package's sources, license files included, are already in the
  project's `deps/`, which Mix fetched from Hex.
- **The backend** (`backend/`) runs on the server and is not distributed.
- **The relay's and Tailscale's servers' code** is not distributed either.
