#!/bin/bash
# Inside the runner VM, as root (cloud-init's first boot, and setup.sh
# again later): the build's toolchain for the user `runner`, and the
# Forgejo runner as a service. Safe to run again: it updates.
#
# /etc/playground-runner.env: FORGEJO_URL and FORGEJO_UUID, the runner
# made in Forgejo's settings (Actions → Runners → Create new runner), and
# FORGEJO_TOKEN, its token, which goes to ~runner/.runner-token from
# there.
# RUNNER_VERSION: the forgejo-runner release (default: the one tried).
set -euo pipefail
. /etc/playground-runner.env
export DEBIAN_FRONTEND=noninteractive

apt-get update -q
apt-get install -yq --no-install-recommends \
  build-essential pkg-config autoconf m4 libssl-dev libncurses-dev unzip \
  git curl ca-certificates rsync openssh-client python3 jq docker.io
usermod -aG docker runner
# build.py and the NIF build run `sudo -n docker`.
echo 'runner ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/runner
chmod 440 /etc/sudoers.d/runner
systemctl enable --now docker

# emsdk 6.0.2 (beam/build.sh) and mise's Erlang and Elixir, the versions
# the BEAM is built from.
sudo -iu runner bash -eu <<'USER'
[ -d ~/emsdk ] || git clone -q https://github.com/emscripten-core/emsdk.git ~/emsdk
~/emsdk/emsdk install 6.0.2
~/emsdk/emsdk activate 6.0.2
[ -x ~/.local/bin/mise ] || curl -sSf https://mise.run | sh
~/.local/bin/mise use -g -y erlang@29.1.1 elixir@1.20.4-otp-29
USER

# The Forgejo runner, with the host executor (run-elixir-build:host).
version=${RUNNER_VERSION:-13.2.0}
if ! /usr/local/bin/forgejo-runner --version 2>/dev/null | grep -q "$version"; then
  base=https://code.forgejo.org/forgejo/runner/releases/download/v$version
  curl -sSfLo /tmp/forgejo-runner "$base/forgejo-runner-$version-linux-amd64"
  expected=$(curl -sSfL "$base/forgejo-runner-$version-linux-amd64.sha256" | cut -d' ' -f1)
  echo "$expected  /tmp/forgejo-runner" | sha256sum -c -
  install -m 755 /tmp/forgejo-runner /usr/local/bin/forgejo-runner
  rm /tmp/forgejo-runner
fi
if [ -n "${FORGEJO_TOKEN:-}" ]; then
  install -o runner -g runner -m 600 /dev/null /home/runner/.runner-token
  printf '%s' "$FORGEJO_TOKEN" > /home/runner/.runner-token
  sed -i '/^FORGEJO_TOKEN=/d' /etc/playground-runner.env
fi
[ -n "${FORGEJO_UUID:-}" ] && [ -s /home/runner/.runner-token ] ||
  { echo "provision: no runner (FORGEJO_UUID, FORGEJO_TOKEN) to run as" >&2; exit 1; }
cat > /etc/systemd/system/forgejo-runner.service <<UNIT
[Unit]
Description=Forgejo runner (run-elixir-build)
After=network-online.target docker.service
Wants=network-online.target

[Service]
User=runner
WorkingDirectory=/home/runner
# The build's tools: mise's Erlang and Elixir (beam/build.sh finds emsdk).
Environment=PATH=/home/runner/.local/bin:/home/runner/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/forgejo-runner daemon --url $FORGEJO_URL --uuid $FORGEJO_UUID \\
  --token-url file:///home/runner/.runner-token --label run-elixir-build:host
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable forgejo-runner
systemctl restart forgejo-runner
echo "provision: forgejo-runner $version running"
