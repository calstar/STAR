#!/usr/bin/env bash
#
# STAR apps-machine bootstrap — from a fresh Ubuntu install to a running stack.
#
# Automates deploy/apps/FRESH-INSTALL.md §1–§6: base packages, desktop
# auto-login, sshd, Docker, repo checkout, and (if the .env is ready) launch.
#
# ── Flash-drive use ──────────────────────────────────────────────────────────
#   1. Copy this file (and, optionally, a filled-in `star-apps.env`) onto a USB.
#   2. On the new box: plug in, open a terminal, then:
#        sudo bash /media/$USER/*/bootstrap.sh
#      (or cd to the drive and `sudo bash bootstrap.sh`)
#
# If a file named `star-apps.env` sits next to this script, it's used as the
# stack's .env and the script launches the stack. Otherwise it drops a template
# .env for you to fill in, and prints how to launch. Secrets never live in this
# script — keep them in star-apps.env (and don't commit that file anywhere).
#
# Safe to re-run: every step checks before acting (idempotent).

set -euo pipefail

# ── Tunables (override via env, e.g. `sudo BRANCH=main bash bootstrap.sh`) ────
REPO_URL="${REPO_URL:-https://github.com/calstar/STAR.git}"
# Current deploy branch: main (landing-page and ork-onshape were merged in and retired).
BRANCH="${BRANCH:-main}"
CLONE_DIR="${CLONE_DIR:-/opt/STAR}"          # where the repo lands on the box
# The human admin account (desktop auto-login + docker group). Defaults to the
# user who invoked sudo.
ADMIN_USER="${ADMIN_USER:-${SUDO_USER:-$(id -un)}}"
# WITH_DAQ=1 also provisions the native DAQ server (build deps, clone, C++ +
# frontend build, systemd --user services) as $ADMIN_USER — see §7. Off by
# default so a pure apps box isn't made to build the DAQ. USE_SIM=1 builds/runs
# the DAQ against the simulator instead of test-stand hardware.
WITH_DAQ="${WITH_DAQ:-0}"
DAQ_CLONE="${DAQ_CLONE:-/home/$ADMIN_USER/STAR-daq}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*" >&2; }

if [[ $EUID -ne 0 ]]; then
  echo "Run me with sudo:  sudo bash $0" >&2
  exit 1
fi
if ! id "$ADMIN_USER" >/dev/null 2>&1; then
  echo "ADMIN_USER='$ADMIN_USER' is not a real account. Set ADMIN_USER=... and re-run." >&2
  exit 1
fi
say "Bootstrapping as admin user: $ADMIN_USER  (repo $REPO_URL@$BRANCH -> $CLONE_DIR)"

# ── §1  Base system ──────────────────────────────────────────────────────────
say "§1 Base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y curl git ca-certificates ufw gnupg

say "§1 Firewall (deny inbound; tunnel is outbound-only)"
ufw default deny incoming
ufw default allow outgoing
# Let the Cloudflare Tunnel connector (a container on a docker bridge) reach the
# host's sshd, so SSH-over-the-tunnel works. Without this, ufw silently DROPS the
# container->host:22 packets and `cloudflared access ssh` times out with
# `dial tcp 172.17.0.1:22: i/o timeout` (a drop, not a refuse). 172.16.0.0/12
# covers every default docker bridge subnet (docker0 + per-compose bridges), and
# being source-based it matches regardless of which bridge iface the packet hits.
ufw allow from 172.16.0.0/12 to any port 22 proto tcp
# Same reason for the DAQ server: it's the one app Caddy reverse-proxies to a
# NATIVE host process (deploy/systemd, :8081 API/WS + :3000 SPA — not a container,
# it needs the test-stand hardware). Without these, the container->host packets are
# silently DROPped and daq-server.<domain> 502s with `dial tcp 172.x.0.1:3000: i/o timeout`.
ufw allow from 172.16.0.0/12 to any port 8081 proto tcp
ufw allow from 172.16.0.0/12 to any port 3000 proto tcp
ufw --force enable

# ── §2  Desktop auto-login (only if a desktop/GDM is present) ────────────────
if [[ -d /etc/gdm3 || -x /usr/sbin/gdm3 ]] || dpkg -l gdm3 >/dev/null 2>&1; then
  say "§2 Desktop detected — enabling auto-login for $ADMIN_USER"
  install -d /etc/gdm3
  cat >/etc/gdm3/custom.conf <<EOF
[daemon]
AutomaticLoginEnable=true
AutomaticLogin=$ADMIN_USER
WaylandEnable=false
EOF
  # Never sleep/suspend — it's a server that must stay reachable.
  systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target || true
  # Kill idle-blank / auto-suspend / lock for the desktop session. These write
  # the user's dconf, so they persist even run from here; but they only take
  # visible effect in a live GNOME session, so we ALSO print them for the user
  # to re-run in their session if a suspend already happened.
  # NOTE: `-H` is essential — without it HOME stays /root and the settings land
  # in root's dconf instead of the user's (they then have no effect on the
  # desktop). dbus-run-session gives a bus so gsettings can write.
  sudo -u "$ADMIN_USER" -H dbus-run-session -- bash -c '
    gsettings set org.gnome.desktop.session idle-delay 0
    gsettings set org.gnome.desktop.screensaver lock-enabled false
    gsettings set org.gnome.desktop.screensaver idle-activation-enabled false
    gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type nothing
    gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-battery-type nothing
  ' 2>/dev/null || warn "gsettings tweaks skipped (no GNOME session yet) — re-run them in the desktop session; the systemctl mask below is the hard stop."
else
  say "§2 No desktop (Ubuntu Server) — skipping auto-login"
fi

# ── §3  SSH server ───────────────────────────────────────────────────────────
say "§3 OpenSSH server"
apt-get install -y openssh-server
systemctl enable --now ssh
# NB: password auth is left enabled so you don't lock yourself out during setup.
# Harden later (after your key is in authorized_keys): FRESH-INSTALL.md §3.

# ── §4  Docker Engine + Compose plugin ───────────────────────────────────────
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  say "§4 Docker already present — skipping"
else
  say "§4 Installing Docker Engine + Compose plugin"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
  # Docker's repo can lag a brand-new Ubuntu (e.g. 26.04). Fall back to the
  # newest published codename, then to Ubuntu's own packages.
  if ! curl -fsSL "https://download.docker.com/linux/ubuntu/dists/${CODENAME}/Release" >/dev/null 2>&1; then
    warn "Docker has no repo for '$CODENAME' yet — falling back to 'noble'."
    CODENAME="noble"
  fi
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu ${CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  if apt-get update -y && apt-get install -y docker-ce docker-ce-cli containerd.io \
       docker-buildx-plugin docker-compose-plugin; then
    :
  else
    warn "Docker apt repo failed — using Ubuntu's docker.io / docker-compose-v2."
    rm -f /etc/apt/sources.list.d/docker.list
    apt-get update -y
    apt-get install -y docker.io docker-compose-v2 docker-buildx
  fi
  systemctl enable --now docker
fi
# Let the admin user run docker without sudo (takes effect on next login).
usermod -aG docker "$ADMIN_USER" || true

# ── §4b cloudflared CLI (native) ─────────────────────────────────────────────
# The tunnel *connector* runs in Docker (the cloudflared compose service), so
# this isn't required for the tunnel — but it gives the box the `cloudflared`
# CLI (e.g. `cloudflared access ssh` to reach other boxes, tunnel debugging).
# The 'any' codename works on every Ubuntu/Debian release (no per-release lag).
if command -v cloudflared >/dev/null 2>&1; then
  say "§4b cloudflared already present — skipping"
else
  say "§4b Installing cloudflared CLI (apt repo, 'any' codename)"
  mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
    -o /usr/share/keyrings/cloudflare-main.gpg
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -y
  apt-get install -y cloudflared
fi

# ── §5  Repo checkout ────────────────────────────────────────────────────────
say "§5 Repo checkout at $CLONE_DIR"
if [[ -d "$CLONE_DIR/.git" ]]; then
  git -C "$CLONE_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$CLONE_DIR" checkout "$BRANCH"
  git -C "$CLONE_DIR" reset --hard "origin/$BRANCH"
else
  git clone --depth 1 --filter=blob:none --sparse -b "$BRANCH" "$REPO_URL" "$CLONE_DIR"
  git -C "$CLONE_DIR" sparse-checkout set deploy/apps
fi
chown -R "$ADMIN_USER":"$ADMIN_USER" "$CLONE_DIR"

# ── .env: use star-apps.env from the flash drive, else lay down a template ────
LAUNCH=1
if [[ -f "$SCRIPT_DIR/star-apps.env" ]]; then
  say "§5 Found star-apps.env next to the script — installing as $CLONE_DIR/.env"
  install -m 600 -o "$ADMIN_USER" -g "$ADMIN_USER" "$SCRIPT_DIR/star-apps.env" "$CLONE_DIR/.env"
elif [[ -f "$CLONE_DIR/.env" ]]; then
  say "§5 Existing $CLONE_DIR/.env kept"
else
  say "§5 No star-apps.env supplied — copying the template for you to fill in"
  install -m 600 -o "$ADMIN_USER" -g "$ADMIN_USER" "$CLONE_DIR/.env.example" "$CLONE_DIR/.env"
  LAUNCH=0
fi

# Refuse to launch with an unconfigured tunnel token (avoids a broken half-start).
if [[ "$LAUNCH" -eq 1 ]] && ! grep -qE '^CLOUDFLARE_TUNNEL_TOKEN=.+' "$CLONE_DIR/.env"; then
  warn "CLOUDFLARE_TUNNEL_TOKEN is empty in .env — not launching yet."
  LAUNCH=0
fi

# ── §6  Launch ───────────────────────────────────────────────────────────────
if [[ "$LAUNCH" -eq 1 ]]; then
  say "§6 Launching the stack (pull + up, tunnel profile)"
  ( cd "$CLONE_DIR" && docker compose --profile tunnel pull \
      && docker compose --profile tunnel up -d && docker compose ps )
  say "Done. Stack is up and behind the tunnel."
else
  cat <<EOF

$(say "Almost there — finish the .env, then launch")
1. Edit the secrets:   sudo -u $ADMIN_USER nano $CLONE_DIR/.env
     JWT_SECRET              = the SAME value as the EC2 auth
     AUTH_VERIFY_ONLY        = true
     SCHEME                  = http
     CLOUDFLARE_TUNNEL_TOKEN = this machine's tunnel token
     (optional) AWS_* + *_S3_BUCKET for durable version history
2. Launch:
     cd $CLONE_DIR && docker compose --profile tunnel pull \\
       && docker compose --profile tunnel up -d
EOF
fi

# ── §7  DAQ server (native, systemd --user) — opt-in via WITH_DAQ=1 ───────────
# The DAQ isn't containerised (it needs the test-stand hardware), so it can't be
# a compose service. This provisions it exactly like deploy/README.md, run as
# $ADMIN_USER (it's a --user install with home-rooted paths). Best-effort: any
# failure warns but never rolls back the apps stack, which is already up.
if [[ "$WITH_DAQ" == "1" ]]; then
  say "§7 DAQ server — build deps + clone + build + services (as $ADMIN_USER)"

  # Build + runtime deps (root). CMake needs ZLIB + OpenSSL + Eigen.
  apt-get install -y build-essential cmake ninja-build libeigen3-dev pkg-config \
    zlib1g-dev libssl-dev python3 python3-venv \
    || warn "§7 build-dep install failed — the DAQ build below will likely fail"

  # Node 20+ for the web GUI (backend tsx + frontend build).
  if ! command -v node >/dev/null 2>&1 || [[ "$(node -v 2>/dev/null | sed 's/v//;s/\..*//')" -lt 20 ]]; then
    say "§7 Installing Node.js 20 (NodeSource)"
    if curl -fsSL https://deb.nodesource.com/setup_20.x | bash -; then
      apt-get install -y nodejs || warn "§7 nodejs install failed"
    else
      warn "§7 NodeSource setup failed — install Node 20+ manually, then re-run WITH_DAQ=1"
    fi
  fi

  # enable-linger (root) so the user's systemd instance runs headless — required
  # before `systemctl --user enable --now` and for services to survive reboot.
  loginctl enable-linger "$ADMIN_USER" || true

  DAQ_UID="$(id -u "$ADMIN_USER")"
  # Everything else runs AS the DAQ user (home-rooted: ~/.cargo/bin/elodin-db,
  # ~/.local/share/elodin, ~/.config/daq, `systemctl --user`).
  if sudo -u "$ADMIN_USER" -H \
       env REPO_URL="$REPO_URL" BRANCH="$BRANCH" DAQ_CLONE="$DAQ_CLONE" \
           USE_SIM="${USE_SIM:-0}" XDG_RUNTIME_DIR="/run/user/$DAQ_UID" \
       bash -euo pipefail -c '
    # Clone shallow (no history) or update in place.
    if [[ -d "$DAQ_CLONE/.git" ]]; then
      git -C "$DAQ_CLONE" fetch --depth 1 origin "$BRANCH"
      git -C "$DAQ_CLONE" reset --hard "origin/$BRANCH"
    else
      git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$DAQ_CLONE"
    fi
    cd "$DAQ_CLONE/daq-server"

    # elodin-db → ~/.cargo/bin (the sensor-elodin unit runs it by absolute path).
    if [[ ! -x "$HOME/.cargo/bin/elodin-db" ]] && ! command -v elodin-db >/dev/null 2>&1; then
      curl --proto "=https" --tlsv1.2 -LsSf \
        https://github.com/elodin-sys/elodin/releases/download/v0.16.1/elodin-db-installer.sh | sh
    fi

    USE_SIM="$USE_SIM" bash scripts/build.sh                    # C++ binaries (build/bin)
    (cd diablo_server/backend  && (npm ci || npm install))
    (cd diablo_server/frontend && (npm ci || npm install))
    bash deploy/startup/ensure_frontend_build.sh               # frontend/dist (served on :3000)

    bash deploy/systemd/install_services.sh                    # units + WorkingDirectory drop-ins
    # Wait for the user bus (enable-linger may still be bringing it up).
    for _ in $(seq 1 20); do systemctl --user show-environment >/dev/null 2>&1 && break; sleep 1; done
    # Always-on web layer; the run pipeline is started on demand by the Session button.
    systemctl --user enable --now sensor-backend sensor-frontend sensor-config-broadcast sensor-heartbeat
  '; then
    say "§7 DAQ up — check: sudo -u $ADMIN_USER XDG_RUNTIME_DIR=/run/user/$DAQ_UID systemctl --user status sensor-backend"
  else
    warn "§7 DAQ provisioning failed — apps stack is unaffected. Re-run: WITH_DAQ=1 sudo -E bash $0"
    warn "    (details + manual steps: daq-server/deploy/README.md)"
  fi
fi

cat <<EOF

$(say "Next (off-box) steps — see deploy/apps/FRESH-INSTALL.md")
• Cloudflare tunnel: add published applications
    <app>.starberkeley.org        -> Service URL http://caddy:80  (one per app)
    ssh-rfs.starberkeley.org       -> Service URL ssh://host.docker.internal:22
• Connect over SSH from your laptop (no open ports):
    ssh -o ProxyCommand="cloudflared access ssh --hostname ssh-rfs.starberkeley.org" \\
      $ADMIN_USER@ssh-rfs.starberkeley.org
• Log out/in once so '$ADMIN_USER' can run docker without sudo.
EOF
