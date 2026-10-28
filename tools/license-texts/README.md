# License texts

License texts that `tools/licenses.py` adds to an inventory when the
files a component ships do not include them (docs/licenses.md).

- `spdx/ID.txt`: the SPDX License List's standard texts,
  [spdx/license-list-data](https://github.com/spdx/license-list-data)
  v3.29.0 (`text/ID.txt`). A component that declares a license but ships
  no license file gets these texts, and a note in its inventory entry.
- `other/LicenseRef-ID.txt`: licenses SPDX does not list, for components
  that name one but ship no text: `LicenseRef-Remix-Icon-1.0` is Remix
  Icon's (`License` in Remix-Design/RemixIcon, "Version 1.0 – January
  2026"), which `@remixicon/react` declares as "Remix Icon License 1.0".
- `wasi-libc/`: wasi-libc's license files at commit
  `2e6fb9d8ee0cdf9e431fbcabe8af3115de000a13`, the wasi-libc of the
  wasi-sdk image the C tools build with. Every wasm32-wasip1 module links
  it: the C tools through wasi-sdk, the Rust tools through Rust's
  self-contained target. `musl-COPYRIGHT` is `libc-top-half/musl/COPYRIGHT`,
  `cloudlibc-LICENSE` is `libc-bottom-half/cloudlibc/LICENSE`, and
  `musl-fts-COPYING` is `fts/musl-fts/COPYING`.
