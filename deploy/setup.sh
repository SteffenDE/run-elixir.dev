#!/bin/bash
# Set up deploys on the production machine, from a clone of the
# repository (deploy.md):
#
#   sudo deploy/setup.sh
#
# Run again, it updates what it installed and keeps what it made. It sets
# up:
#
# - the user `deploy`, the site's directory (SITE), playground-deploy at
#   /usr/local/bin and /etc/playground-deploy.env;
# - a deploy key that may only run playground-deploy, in deploy's
#   authorized_keys;
# - the Forgejo runner, in a QEMU VM of its own (Ubuntu's cloud image,
#   cloud-init, user-mode networking: no bridge or firewall changes), as
#   the systemd service playground-runner. The VM reaches this machine's
#   sshd at 10.0.2.2 with the deploy key (ssh's host `playground-prod`
#   there); its own sshd is at 127.0.0.1:RUNNER_SSH_PORT for
#   `ssh -i /var/lib/playground-runner/admin_key runner@127.0.0.1 -p PORT`.
#
# Asked for the first time (or given in the environment): DOMAIN,
# FORGEJO_URL, and the runner made in Forgejo (the repository's or the
# user's Settings → Actions → Runners → Create new runner): its
# FORGEJO_UUID and FORGEJO_TOKEN. Given to a later run, those two replace
# the VM's. The VM's
# size: RUNNER_CPUS (half the cores), RUNNER_MEMORY (16G), RUNNER_DISK
# (120G), RUNNER_SSH_PORT (2222); kept in /etc/playground-runner.env.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
[ "$(id -u)" = 0 ] || { echo "setup.sh: run it as root (sudo)" >&2; exit 1; }

DEPLOY_ENV=/etc/playground-deploy.env
RUNNER_ENV=/etc/playground-runner.env
VM=/var/lib/playground-runner
IMAGE_URL=https://cloud-images.ubuntu.com/releases/noble/release
IMAGE=ubuntu-24.04-server-cloudimg-amd64.img

say() { echo "setup.sh: $*"; }

# A setting: the environment's, the saved one, or asked (with a default).
setting() {
  local name=$1 default=$2 file=$3 question=$4 value
  value=${!name:-}
  if [ -z "$value" ] && [ -f "$file" ]; then
    value=$(sed -n "s/^$name=//p" "$file" | tail -n 1)
  fi
  if [ -z "$value" ]; then
    if [ -t 0 ]; then
      read -r -p "$question [$default]: " value
    fi
    value=${value:-$default}
  fi
  printf -v "$name" '%s' "$value"
}

# name=value into an env file, replacing an earlier one.
save() {
  local file=$1 name=$2 value=$3
  touch "$file"
  sed -i "/^$name=/d" "$file"
  echo "$name=$value" >> "$file"
}

# --- Packages -------------------------------------------------------------
need=()
for pair in qemu-system-x86_64:qemu-system-x86 qemu-img:qemu-utils cloud-localds:cloud-image-utils \
            rsync:rsync rrsync:rsync curl:curl python3:python3 ssh-keygen:openssh-client; do
  command -v "${pair%%:*}" >/dev/null || need+=("${pair#*:}")
done
if [ ${#need[@]} -gt 0 ]; then
  command -v apt-get >/dev/null || { echo "setup.sh: install ${need[*]} (no apt-get here)" >&2; exit 1; }
  say "installing ${need[*]}"
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -yq --no-install-recommends "${need[@]}"
fi
[ -e /dev/kvm ] || { echo "setup.sh: no /dev/kvm: the runner VM needs KVM" >&2; exit 1; }

# --- The deploy side ------------------------------------------------------
setting DOMAIN run-elixir.dev "$DEPLOY_ENV" "The project domain (empty: none)"
setting SITE "/srv/playground/${DOMAIN%%.*}" "$DEPLOY_ENV" "The site's directory (Caddy's root is its current/)"
if [ ! -f "$DEPLOY_ENV" ]; then
  cat > "$DEPLOY_ENV" <<EOF
# playground-deploy's settings (its header lists them all).
SITE=$SITE
DOMAIN=$DOMAIN
# Cloudflare, to purge the pages: a token with Zone → Cache Purge only.
#CF_ZONE_ID=
#CF_API_TOKEN=
EOF
  chmod 640 "$DEPLOY_ENV"
fi
id deploy >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/deploy --shell /bin/bash deploy
chgrp deploy "$DEPLOY_ENV"
install -d -o deploy -g deploy -m 755 "$SITE" "$SITE/releases"
install -m 755 "$HERE/server/playground-deploy" /usr/local/bin/playground-deploy
say "playground-deploy installed; the site goes to $SITE/current"

# The deploy key: made here, given to the VM, and in authorized_keys
# limited to playground-deploy.
install -d -m 700 "$VM"
[ -f "$VM/deploy_key" ] || ssh-keygen -q -t ed25519 -N '' -C playground-runner-deploy -f "$VM/deploy_key"
install -d -o deploy -g deploy -m 700 /var/lib/deploy/.ssh
keys=/var/lib/deploy/.ssh/authorized_keys
touch "$keys"
if ! grep -qF "$(cut -d' ' -f2 "$VM/deploy_key.pub")" "$keys"; then
  echo "command=\"/usr/local/bin/playground-deploy\",restrict $(cat "$VM/deploy_key.pub")" >> "$keys"
fi
chown deploy:deploy "$keys"
chmod 600 "$keys"

# --- The runner VM --------------------------------------------------------
setting RUNNER_CPUS "$(( $(nproc) / 2 ))" "$RUNNER_ENV" "The runner VM's CPUs"
setting RUNNER_MEMORY 16G "$RUNNER_ENV" "The runner VM's memory"
setting RUNNER_DISK 120G "$RUNNER_ENV" "The runner VM's disk"
setting RUNNER_SSH_PORT 2222 "$RUNNER_ENV" "The local port of the VM's sshd"
for name in RUNNER_CPUS RUNNER_MEMORY RUNNER_DISK RUNNER_SSH_PORT; do save "$RUNNER_ENV" "$name" "${!name}"; done
chmod 600 "$RUNNER_ENV"
id playground-runner >/dev/null 2>&1 ||
  useradd --system --home-dir "$VM" --shell /usr/sbin/nologin --groups kvm playground-runner
[ -f "$VM/admin_key" ] || ssh-keygen -q -t ed25519 -N '' -C playground-runner-admin -f "$VM/admin_key"
ssh_port=$(sshd -T 2>/dev/null | sed -n 's/^port //p' | head -n 1)
ssh_port=${ssh_port:-22}
host_key=$(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)
[ "$ssh_port" = 22 ] && known="10.0.2.2 $host_key" || known="[10.0.2.2]:$ssh_port $host_key"

if [ ! -f "$VM/runner.qcow2" ]; then
  # The clone's remote names the instance (ssh://git@HOST:PORT/…,
  # git@HOST:…, https://HOST/…).
  setting FORGEJO_URL "$(git -c safe.directory='*' -C "$HERE" remote get-url origin 2>/dev/null |
    sed -E 's#^https?://([^/]+).*#https://\1#; t; s#^(ssh://)?([^@]*@)?([^:/]+).*#https://\3#')" \
    /dev/null "Forgejo's URL"
  setting FORGEJO_UUID "" /dev/null "The runner's UUID (Forgejo: Actions → Runners → Create new runner)"
  setting FORGEJO_TOKEN "" /dev/null "The runner's token"
  [ -n "$FORGEJO_UUID" ] && [ -n "$FORGEJO_TOKEN" ] || { echo "setup.sh: the runner's UUID and token are needed" >&2; exit 1; }
  say "fetching $IMAGE"
  curl -sSfLo "$VM/$IMAGE.part" "$IMAGE_URL/$IMAGE"
  expected=$(curl -sSfL "$IMAGE_URL/SHA256SUMS" | sed -n "s/^\([0-9a-f]*\) \*$IMAGE\$/\1/p")
  echo "$expected  $VM/$IMAGE.part" | sha256sum -c --quiet -
  mv "$VM/$IMAGE.part" "$VM/base.img"
  qemu-img create -q -f qcow2 -F qcow2 -b base.img "$VM/runner.qcow2" "$RUNNER_DISK"

  # cloud-init: the user, the keys, ssh's host playground-prod, the
  # settings, and the first provisioning.
  seed=$(mktemp -d)
  trap 'rm -rf "$seed"' EXIT
  indent() { sed 's/^/      /' "$1"; }
  printf 'FORGEJO_URL=%s\nFORGEJO_UUID=%s\nFORGEJO_TOKEN=%s\n' "$FORGEJO_URL" "$FORGEJO_UUID" "$FORGEJO_TOKEN" > "$seed/runner.env"
  cat > "$seed/ssh_config" <<EOF
Host playground-prod
  HostName 10.0.2.2
  Port $ssh_port
  User deploy
  IdentityFile ~/.ssh/playground-deploy
  IdentitiesOnly yes
  StrictHostKeyChecking yes
EOF
  cat > "$seed/user-data" <<EOF
#cloud-config
hostname: playground-runner
users:
  - name: runner
    shell: /bin/bash
    ssh_authorized_keys:
      - $(cat "$VM/admin_key.pub")
write_files:
  - path: /etc/playground-runner.env
    permissions: '0600'
    content: |
$(indent "$seed/runner.env")
  - path: /root/provision.sh
    permissions: '0755'
    content: |
$(indent "$HERE/runner/provision.sh")
  - path: /home/runner/.ssh/playground-deploy
    permissions: '0600'
    owner: runner:runner
    defer: true
    content: |
$(indent "$VM/deploy_key")
  - path: /home/runner/.ssh/config
    permissions: '0600'
    owner: runner:runner
    defer: true
    content: |
$(indent "$seed/ssh_config")
  - path: /home/runner/.ssh/known_hosts
    permissions: '0600'
    owner: runner:runner
    defer: true
    content: |
      $known
runcmd:
  - [/root/provision.sh]
EOF
  printf 'instance-id: playground-runner\nlocal-hostname: playground-runner\n' > "$seed/meta-data"
  cloud-localds "$VM/seed.iso" "$seed/user-data" "$seed/meta-data"
  rm -rf "$seed"
  trap - EXIT
  # The token has done its work once the VM has it.
  unset FORGEJO_UUID FORGEJO_TOKEN
fi
chown -R playground-runner:playground-runner "$VM"
chmod 600 "$VM/seed.iso"

cat > /etc/systemd/system/playground-runner.service <<EOF
[Unit]
Description=The playground's Forgejo runner, in a QEMU VM
After=network-online.target
Wants=network-online.target

[Service]
User=playground-runner
Group=kvm
EnvironmentFile=$RUNNER_ENV
RuntimeDirectory=playground-runner
ExecStart=/usr/bin/qemu-system-x86_64 -name playground-runner \\
  -machine q35,accel=kvm -cpu host -smp \${RUNNER_CPUS} -m \${RUNNER_MEMORY} \\
  -drive file=$VM/runner.qcow2,if=virtio,discard=unmap \\
  -drive file=$VM/seed.iso,if=virtio,format=raw,readonly=on \\
  -nic user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:\${RUNNER_SSH_PORT}-:22 \\
  -device virtio-rng-pci -display none -serial file:$VM/console.log \\
  -monitor unix:/run/playground-runner/monitor,server,nowait
# A clean shutdown: ACPI power off, then wait for QEMU to go.
ExecStop=/usr/bin/python3 -c "import socket; s = socket.socket(socket.AF_UNIX); s.connect('/run/playground-runner/monitor'); s.sendall(b'system_powerdown\\\\n')"
ExecStop=/bin/sh -c 'while kill -0 \$MAINPID 2>/dev/null; do sleep 1; done'
TimeoutStopSec=180
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable playground-runner >/dev/null
if systemctl is-active -q playground-runner; then
  # Running: bring its toolchain and runner up to date.
  say "updating the runner VM"
  ssh=(ssh -i "$VM/admin_key" -p "$RUNNER_SSH_PORT" -o StrictHostKeyChecking=accept-new
       -o UserKnownHostsFile="$VM/known_hosts" runner@127.0.0.1)
  "${ssh[@]}" sudo tee /root/provision.sh >/dev/null < "$HERE/runner/provision.sh"
  # A runner given now (its UUID and token) replaces the VM's.
  for name in FORGEJO_UUID FORGEJO_TOKEN; do
    [ -n "${!name:-}" ] || continue
    "${ssh[@]}" sudo sed -i "/^$name=/d" /etc/playground-runner.env
    printf '%s=%s\n' "$name" "${!name}" | "${ssh[@]}" sudo tee -a /etc/playground-runner.env >/dev/null
  done
  "${ssh[@]}" sudo bash /root/provision.sh
else
  systemctl start playground-runner
  say "the runner VM is starting; its first boot provisions it (several minutes):"
  say "  tail -f $VM/console.log"
fi
cat <<EOF

Done. Still to do by hand:
- Caddy's root: $SITE/current (docs/deploy.md).
- Cloudflare's CF_ZONE_ID and CF_API_TOKEN in $DEPLOY_ENV, if wanted.
- The repository's variables: PLAYGROUND_DOMAIN=$DOMAIN (DEPLOY_TARGET defaults
  to playground-prod, the VM's way here).
EOF
