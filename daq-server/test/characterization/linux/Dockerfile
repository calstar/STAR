# Linux leg of the remaster gate (docs/remaster/LEDGER.md D15/D16): CI's toolchain on ubuntu:24.04.
FROM ubuntu:24.04
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake ninja-build g++-12 gcc-12 clang-18 libssl-dev zlib1g-dev libeigen3-dev \
      pkg-config python3 python3-pip python3-numpy curl ca-certificates git lsof psmisc iproute2 ffmpeg xz-utils \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*
# elodin-db: the pinned v0.16.1 (deploy/README.md), installed where the harness looks for it, from
# the release's checksummed tarball. It uses io_uring, which Docker's default seccomp profile
# blocks (panics with EPERM), so it is not run here and linux_gate.sh runs with seccomp=unconfined.
ARG TARGETARCH
RUN set -e; case "$TARGETARCH" in arm64) a=aarch64 ;; amd64) a=x86_64 ;; esac; \
    f="elodin-db-$a-unknown-linux-musl.tar.gz"; \
    u="https://github.com/elodin-sys/elodin/releases/download/v0.16.1/$f"; \
    cd /tmp && curl -fsSLO "$u" && curl -fsSL "$u.sha256" | sed 's/ \*/  /' | sha256sum -c - \
    && tar xzf "$f" && mkdir -p /root/.cargo/bin && install "elodin-db-$a-unknown-linux-musl/elodin-db" /root/.cargo/bin/ \
    && rm -rf /tmp/elodin-db*
ENV PATH=/root/.cargo/bin:$PATH
WORKDIR /src
