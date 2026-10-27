# syntax=docker/dockerfile:1

# Builds the playground backend's release, and the sandbox VM that it builds
# NIF libraries in. The VM's artifacts are not in the release's image: they
# are built on their own (sandbox/build, or mix sandbox.setup) and mounted.
# Two named contexts come from the repository, besides this directory
# (sandbox/build and Playground.Sandbox.Builder pass them):
#
#   * nif - nif/: the erl_nif layer and nifcc
#
# The sandbox stages, the only definition of the VM:
#
#   * sandbox-kernel - the Linux kernel the VM boots
#   * sandbox-rootfs - the root disk, made from sandbox-image, the guest's userspace
#   * sandbox-netd - sandbox-netd, which runs on the host next to the VM
#
# The image runs Firecracker with KVM, so it needs /dev/kvm, and the
# artifacts at PLAYGROUND_SANDBOX_DIR, see docker-compose.yml. (Adapted from
# SCA's.)

ARG ELIXIR_VERSION=1.20.4
ARG OTP_VERSION=29.1.2
ARG DEBIAN_VERSION=trixie-20261005

ARG BUILDER_IMAGE="docker.io/hexpm/elixir:${ELIXIR_VERSION}-erlang-${OTP_VERSION}-debian-${DEBIAN_VERSION}-slim"
ARG RUNNER_IMAGE="docker.io/debian:${DEBIAN_VERSION}-slim"

# wasi-sdk 33 (clang 23), as nif/build.py pins it.
ARG WASI_SDK_IMAGE="ghcr.io/webassembly/wasi-sdk@sha256:52595085a0ffbaf574d8d678a9aa81305f0b3af81c639291f15bc7713e42848e"

## Sandbox

FROM ${WASI_SDK_IMAGE} AS wasi-sdk

# The guest's userspace: wasi-sdk with the erl_nif layer at the paths
# nif/build.py uses (/nif/include, /nif/lib/beamos_nif.o,
# /tools/nifcc and /tools/nifc++), so recipes carry over unchanged. Erlang is
# there for Makefiles that ask erl where ERTS's headers are; build tools for
# what packages bring along (CMake, autotools, git for those that clone).
FROM docker.io/hexpm/elixir:${ELIXIR_VERSION}-erlang-${OTP_VERSION}-debian-${DEBIAN_VERSION} AS sandbox-image

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      autoconf automake build-essential ca-certificates cmake curl git iproute2 \
      libtool ninja-build pkg-config python3 unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*

COPY --from=wasi-sdk /opt/wasi-sdk /opt/wasi-sdk

COPY --from=nif include/erl_nif.h include/erl_nif_api_funcs.h include/erl_drv_nif.h \
  include/erl_int_sizes_config.h /nif/include/
COPY --from=nif beamos_nif.c /nif/src/
RUN mkdir /nif/lib \
    && /opt/wasi-sdk/bin/clang -O2 -Wall -Wextra -Wno-unused-parameter -I/nif/include \
      -c /nif/src/beamos_nif.c -o /nif/lib/beamos_nif.o
COPY --chmod=0755 --from=nif nifcc /tools/nifcc
COPY --chmod=0755 --from=nif nifcc /tools/nifc++

# What a library was built with: the layer, its headers, nifcc and wasi-sdk.
# make-rootfs puts it in manifest.json, and builds are kept per toolchain.
RUN cat /nif/include/* /nif/src/beamos_nif.c /tools/nifcc /opt/wasi-sdk/VERSION \
      | sha256sum | cut -c1-16 >/nif/toolchain
# What a library can be loaded by (docs/nif.md): the layer's protocol and
# its erl_nif.h's version, as nif/build.py works it out ("1-2.18"). Pages
# ask for builds of one, and this backend makes only its own.
RUN layer=$(sed -n 's/^#define BEAMOS_NIF_ABI \([0-9]*\)$/\1/p' /nif/src/beamos_nif.c) \
    && major=$(sed -n 's/^#define ERL_NIF_MAJOR_VERSION \([0-9]*\)$/\1/p' /nif/include/erl_nif.h) \
    && minor=$(sed -n 's/^#define ERL_NIF_MINOR_VERSION \([0-9]*\)$/\1/p' /nif/include/erl_nif.h) \
    && echo "$layer-$major.$minor" >/nif/abi && grep -qx '[0-9][0-9]*-[0-9][0-9]*\.[0-9][0-9]*' /nif/abi

# Jobs run as this user, in a tmpfs mounted at /workspace by the guest init.
RUN groupadd --gid 1000 sandbox \
    && useradd --uid 1000 --gid 1000 --home-dir /workspace --no-create-home sandbox \
    && mkdir -p /workspace

ENV MIX_HOME=/usr/local/lib/mix
RUN mix local.hex --force && mix local.rebar --force

# sandbox-vsock connects the guest to the host over vsock, see
# Playground.Sandbox.Firecracker.
FROM sandbox-image AS sandbox-vsock-build

COPY sandbox/vsock/sandbox-vsock.c /src/
RUN mkdir /out \
    && gcc -std=gnu17 -O2 -Wall -Wextra -Werror -o /out/sandbox-vsock /src/sandbox-vsock.c

FROM docker.io/debian:trixie-slim AS sandbox-kernel-build

# If necessary, update to the latest LTS from https://kernel.org
ARG KERNEL_VERSION=6.18.50
ARG KERNEL_SHA256=d2fc041dab4e11d9645e3ba53be058faa52b8ce28a8a97c889bb2cacee170461
ARG TARGETARCH

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      bc \
      bison \
      build-essential \
      ca-certificates \
      curl \
      flex \
      libelf-dev \
      libssl-dev \
      xz-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

RUN curl --fail --location --output linux.tar.xz \
      "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-${KERNEL_VERSION}.tar.xz" \
    && echo "${KERNEL_SHA256}  linux.tar.xz" | sha256sum --check --strict \
    && tar --extract --file linux.tar.xz \
    && mv "linux-${KERNEL_VERSION}" linux \
    && rm linux.tar.xz

COPY sandbox/kernel/common.config sandbox/kernel/arm64.config sandbox/kernel/amd64.config /configs/
COPY sandbox/kernel/build-kernel /usr/local/bin/build-kernel

RUN build-kernel "$TARGETARCH"

FROM scratch AS sandbox-kernel
COPY --from=sandbox-kernel-build /output/ /

FROM --platform=$BUILDPLATFORM docker.io/debian:trixie-slim AS sandbox-rootfs-build

RUN apt-get update \
    && apt-get install --yes --no-install-recommends e2fsprogs fdisk \
    && rm -rf /var/lib/apt/lists/*

COPY --from=sandbox-image / /rootfs
COPY sandbox/rootfs/sandbox-init /rootfs/usr/lib/sandbox/sandbox-init
COPY --from=sandbox-vsock-build /out/sandbox-vsock /rootfs/usr/lib/sandbox/sandbox-vsock
COPY sandbox/rootfs/make-rootfs /usr/local/bin/make-rootfs

# Docker provides these files to running containers, so the image doesn't have
# its own. The root disk is read-only, so the guest init writes the name server
# to /run instead.
COPY sandbox/rootfs/hosts /rootfs/etc/hosts
RUN ln -sf /run/resolv.conf /rootfs/etc/resolv.conf

RUN make-rootfs /rootfs /output

FROM scratch AS sandbox-rootfs
COPY --from=sandbox-rootfs-build /output/ /

# sandbox-netd runs next to the VM, so unlike the other artifacts it's built
# for the host, which mix sandbox.setup passes, or for this image. Go
# cross-compiles without cgo, so the build always runs natively.
FROM --platform=$BUILDPLATFORM docker.io/golang:1.26.8-trixie AS sandbox-netd-build

ARG TARGETARCH
ARG TARGET_OS=linux
ARG TARGET_ARCH=$TARGETARCH

WORKDIR /src

COPY sandbox/netd/go.mod sandbox/netd/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY sandbox/netd/*.go ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go vet ./... \
    && CGO_ENABLED=0 GOOS="$TARGET_OS" GOARCH="$TARGET_ARCH" \
      go build -trimpath -ldflags="-s -w" -o /out/sandbox-netd .

FROM scratch AS sandbox-netd
COPY --from=sandbox-netd-build /out/sandbox-netd /sandbox-netd

# Firecracker's releases are static binaries, checked against the checksum
# published with them.
FROM docker.io/debian:trixie-slim AS firecracker

ARG FIRECRACKER_VERSION=v1.17.0
ARG TARGETARCH

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /download

RUN case "$TARGETARCH" in \
      amd64) arch=x86_64 ;; \
      arm64) arch=aarch64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && release="firecracker-${FIRECRACKER_VERSION}-${arch}" \
    && url="https://github.com/firecracker-microvm/firecracker/releases/download/${FIRECRACKER_VERSION}" \
    && curl --fail --location --remote-name "$url/$release.tgz" \
    && curl --fail --location --remote-name "$url/$release.tgz.sha256.txt" \
    && sha256sum --check --strict "$release.tgz.sha256.txt" \
    && tar --extract --file "$release.tgz" \
    && install -D "release-${FIRECRACKER_VERSION}-${arch}/$release" /out/firecracker

## Release

FROM ${BUILDER_IMAGE} AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN mix local.hex --force \
  && mix local.rebar --force

ENV MIX_ENV="prod"

COPY mix.exs mix.lock ./
RUN mix deps.get --only $MIX_ENV
RUN mkdir config

# Compile-time config is copied before compiling dependencies, so that a change
# to it recompiles them.
COPY config/config.exs config/${MIX_ENV}.exs config/
RUN mix deps.compile

COPY priv priv

COPY lib lib

RUN mix compile

# Changes to config/runtime.exs don't require recompiling the code
COPY config/runtime.exs config/

COPY rel rel
RUN mix release

FROM ${RUNNER_IMAGE} AS final

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       libstdc++6 openssl libncurses6 locales ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=firecracker /out/firecracker /usr/local/bin/firecracker

RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen \
  && locale-gen

ENV LANG=en_US.UTF-8
ENV LANGUAGE=en_US:en
ENV LC_ALL=en_US.UTF-8

WORKDIR "/app"
RUN chown nobody /app

# Hex tarballs and built libraries are kept outside the release, in a volume,
# and the sandbox's artifacts come in another (read-only).
ENV PLAYGROUND_DATA_DIR=/var/lib/playground
ENV PLAYGROUND_SANDBOX_DIR=/var/lib/playground-sandbox
RUN mkdir -p "$PLAYGROUND_DATA_DIR" "$PLAYGROUND_SANDBOX_DIR" && chown nobody "$PLAYGROUND_DATA_DIR"

ENV MIX_ENV="prod"

COPY --from=builder --chown=nobody:root /app/_build/${MIX_ENV}/rel/playground ./

USER nobody

CMD ["/app/bin/server"]
