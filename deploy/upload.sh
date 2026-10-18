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
build=$(sed -n 's/.*<meta name="playground-build" content="\([0-9a-f]*\)".*/\1/p' "$site/index.html" | head -n 1)
[ -n "$build" ] || { echo "upload.sh: $site/index.html names no build" >&2; exit 1; }
runtime=$(sed -n 's/.*<meta name="playground-runtime" content="\([0-9a-f]*\)".*/\1/p' "$site/index.html" | head -n 1)
[ -n "$runtime" ] || { echo "upload.sh: $site/index.html names no runtime" >&2; exit 1; }
commit=${GITHUB_SHA:-$(git -C "$(dirname "$0")" rev-parse HEAD)}
rid=$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%s' "$commit" | cut -c1-12)
# The server seeds the release with the live one's files, hard-linked,
# and this build's and runtime's directories with the live ones': the
# upload sends only what changed (by checksum, as each build's files are
# new on disk), and never touches a live file (rsync replaces a changed
# file by renaming). The older builds and runtimes the release carries
# are kept (P), for pages loaded before.
$ssh "$target" prepare "$rid" "$build" "$runtime"
rsync -rlc --chmod=D755,F644 --delete --filter='P /b/*' --filter='P /r/*' -e "$ssh" "$site/" "$target:$rid.partial/"
$ssh "$target" activate "$rid"
