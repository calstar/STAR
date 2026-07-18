# Minimal Ubuntu image for testing setup.sh from scratch.
#
# Only installs what's needed to bootstrap: sudo (setup.sh calls apt-get via
# sudo), curl/git/ca-certificates (for NodeSource + rustup + elodin-db), and
# rsync (used by run-docker.sh to copy the repo into a writable volume).
#
# Everything else — build-essential, cmake, python venv, node, etc — must be
# installed by setup.sh itself. That's the whole point of the test.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
      sudo \
      curl \
      ca-certificates \
      git \
      rsync \
      bash \
      xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Non-root user with passwordless sudo. setup.sh calls `sudo apt-get install`
# and would hang forever on a password prompt otherwise.
RUN useradd -m -s /bin/bash tester \
    && echo "tester ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

USER tester
WORKDIR /home/tester
