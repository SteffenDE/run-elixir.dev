#!/bin/sh
# Deploy a built site as a new release (deploy.md):
#
#   deploy/upload.sh SITE TARGET
#
# SITE: the built site (target/site); TARGET: user@host, whose
# key runs playground-deploy on the server. DEPLOY_SSH: the ssh command
# (default ssh). The release is named by the time and the commit
# (GITHUB_SHA, else HEAD).
set -eu
site=${1:?site directory}
target=${2:?user@host}
ssh=${DEPLOY_SSH:-ssh}
meta() { sed -n "s/.*<meta name=\"playground-$1\" content=\"\([^\"]*\)\".*/\1/p" "$site/index.html" | head -n 1; }
runtime=$(meta runtime)
[ -n "$runtime" ] || { echo "upload.sh: $site/index.html names no runtime" >&2; exit 1; }
manifest=$(meta site)
[ -s "$site$manifest" ] || { echo "upload.sh: $site/index.html names no site manifest" >&2; exit 1; }
# What the release runs with: the runtime package, and what the site
# manifest names (the packages and the recordings).
dirs=$(printf '%s\n' "$runtime" | sed 's|^/||; s|/$||'
       sed -n 's|.*"base": "\.\./\([^"]*\)/".*|\1|p' "$site$manifest")
commit=${GITHUB_SHA:-$(git -C "$(dirname "$0")" rev-parse HEAD)}
rid=$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%s' "$commit" | cut -c1-12)
# The server seeds the release with the live one's files, hard-linked,
# and each new package's directory with the live one's of the same
# package: the upload sends only what changed (by checksum, as each
# build's files are new on disk), and never touches a live file (rsync
# replaces a changed file by renaming). The older versions the release
# carries are kept (P), for pages loaded before.
# shellcheck disable=SC2086 # one word each
$ssh "$target" prepare "$rid" $dirs
rsync -rlc --chmod=D755,F644 --delete --filter='P /npm/@elixir-playground/*' --filter='P /boot/*' \
  --filter='P /site/*' --filter='P /b/*' --filter='P /r/*' \
  -e "$ssh" "$site/" "$target:$rid.partial/"
$ssh "$target" activate "$rid"
