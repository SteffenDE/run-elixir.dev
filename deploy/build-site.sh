#!/bin/bash
# The site from this checkout, as a deploy builds it (deploy.md): the
# native Rust-OTP install it is made from, the NIF libraries, then the
# site into target/site. PLAYGROUND_DOMAIN names the project
# domain, if any.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
. scripts/erlang-env.sh
# tools/rotp/install.exs takes the prebuilt backend and binary.
cargo build --release -p beam-compiler --example compile-module
cargo build --release -p rotp
elixir tools/rotp/install.exs
python3 -I nif/build.py
python3 -I runtime/build.py
