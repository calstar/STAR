# Linux leg of the remaster gate (docs/remaster/LEDGER.md D15/D16): CI's toolchain on ubuntu:24.04.
FROM ubuntu:24.04
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake ninja-build g++-12 gcc-12 clang-18 libssl-dev zlib1g-dev libeigen3-dev \
      pkg-config python3 python3-pip curl ca-certificates git lsof psmisc iproute2 ffmpeg xz-utils \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*
# elodin-db: the pinned v0.16.1 (deploy/README.md), installed where the harness looks for it.
RUN curl -LsSf https://github.com/elodin-sys/elodin/releases/download/v0.16.1/elodin-db-installer.sh | sh \
    && /root/.cargo/bin/elodin-db --version
ENV PATH=/root/.cargo/bin:$PATH
WORKDIR /src
