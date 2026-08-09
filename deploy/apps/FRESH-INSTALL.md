# Apps machine — full setup from a fresh Linux install

End-to-end provisioning for the **apps machine** (Engine Design, P&ID Designer,
Recovery Calculator, Onshape Viewer, landing) starting from a blank Ubuntu
install. It layers the base OS + Docker + SSH-over-Cloudflare underneath the
app-level runbook in [`README.md`](README.md) — do that one after this.

```
Internet ─▶ Cloudflare edge ─▶ cloudflared (in Docker) ─┬▶ caddy:80  ─▶ apps
                                                        └▶ host:22   ─▶ sshd  (remote admin)
```

One tunnel, one connector. The web apps and SSH both ride it, so **no inbound
ports need to be open on the box** — not even 22.

---

## 0. Install Ubuntu

Use a current **Ubuntu LTS** — **24.04** or **26.04** both work (Desktop or
Server — Desktop if you want the graphical session in §2; Server is lighter if
you never need a screen). Nothing below is version-specific except the Docker
repo codename caveat called out in §4.

During install:
- Create your admin user (examples below use `star`).
- Tick **"Install OpenSSH server"** if the installer offers it (Server does;
  Desktop doesn't — §3 installs it).
- Let it finish, reboot, and log in once at the console.

Everything below is run as your admin user with `sudo`.

---

## 1. Base system

```bash
sudo apt update && sudo apt -y upgrade
sudo apt -y install curl git ca-certificates ufw
```

Optional but recommended — a firewall that trusts nothing inbound (the tunnel
is outbound-only, so you lose no access by doing this):

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw --force enable
```

> Keep a physical console or a cloud web-console handy the first time — until
> the tunnel is up (§6) this firewall means no inbound SSH.

---

## 2. Boot straight into the desktop (no login screen)

Skip this whole section on **Ubuntu Server** (no GUI). On **Desktop**, Ubuntu
uses GDM3, which stops at a login screen by default. To boot straight to the
desktop for your user:

```bash
sudo install -d /etc/gdm3
sudo tee /etc/gdm3/custom.conf >/dev/null <<'EOF'
[daemon]
AutomaticLoginEnable=true
AutomaticLogin=star          # ← your username
WaylandEnable=false          # X11 is steadier for headless/remote-viewed boxes
EOF
```

Then stop the box from sleeping or locking itself (it's a server that must stay
reachable):

```bash1
# Never suspend/hibernate, even the desktop's idle timers.
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target

# Disable GNOME idle-blank + auto-suspend + screen lock for the logged-in user.
sudo -u star dbus-run-session -- bash -c '
  gsettings set org.gnome.desktop.session idle-delay 0
  gsettings set org.gnome.desktop.screensaver lock-enabled false
  gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type nothing
  gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-battery-type nothing
' 2>/dev/null || true
```

                                                                                                                                        
Reboot and confirm it lands on the desktop with no prompt:

```bash
sudo reboot
```

> The GNOME login **keyring** can still pop a password dialog the first time an
> app wants it, because auto-login leaves the keyring locked. If that bites you,
> set an empty keyring password once: **Passwords and Keys** (`seahorse`) →
> right-click *Login* keyring → *Change Password* → new password blank.

---

## 3. SSH server

```bash
sudo apt -y install openssh-server
sudo systemctl enable --now ssh
```

Harden it a little (optional but sensible, since the only way in will be the
tunnel + your key):

```bash
# Put your public key on the box first:  ssh-copy-id star@<lan-ip>   (from your laptop)
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

---

## 4. Docker Engine + Compose plugin

Official Docker apt repo (the `docker compose` v2 plugin comes with it):

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt update
sudo apt -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Run docker without sudo (log out/in, or `newgrp docker`, to pick up the group)
sudo usermod -aG docker "$USER"
sudo systemctl enable --now docker
```

Verify:

```bash
newgrp docker
docker run --rm hello-world
docker compose version
```

> **Fresh Ubuntu release (e.g. 26.04)?** Docker's repo can lag a new LTS by a
> while, so `$VERSION_CODENAME` may 404 during `apt update`. Two fixes:
> - Pin the repo to the newest codename Docker *does* publish (check
>   <https://download.docker.com/linux/ubuntu/dists/>) — replace
>   `$(. /etc/os-release && echo $VERSION_CODENAME)` in the `docker.list` line
>   with e.g. `noble`, then re-run the `apt update`/install.
> - Or skip Docker's repo entirely and use Ubuntu's own packages:
>   `sudo apt -y install docker.io docker-compose-v2 docker-buildx`. Same
>   `docker` + `docker compose` commands; just a slightly older engine.

---

## 5. Cloudflare — the tunnel for this machine

In **Cloudflare Zero Trust → Networks → Tunnels**, create a tunnel (connector
type **Docker**) for this box and copy its **token** (goes in `.env` as
`CLOUDFLARE_TUNNEL_TOKEN`, §6). Then add routes with **Add published
application** (Cloudflare's newer UI — this is the renamed "Public Hostname").

> **UI note:** the new form has no service *type* dropdown. The **type is the
> scheme you type into the Service URL** — `http://…` for the web apps,
> `ssh://…` for SSH (its own hint shows `tcp://localhost:3306` as an example).
> Leave **Path** empty.

Web routes — Service URL `http://caddy:80` for each:

| Hostname | Service URL |
| --- | --- |
| `starberkeley.org` (apex → landing) | `http://caddy:80` |
| `engine-design.starberkeley.org` | `http://caddy:80` |
| `pid-designer.starberkeley.org` | `http://caddy:80` |
| `recovery-calculator.starberkeley.org` | `http://caddy:80` |
| `onshape-viewer.starberkeley.org` | `http://caddy:80` |

Do **not** add `auth.` here — that stays on the EC2 tunnel. The SSH route is §5a.

### 5a. Add the SSH route to the same tunnel

**Add published application** again:

- **Subdomain:** `ssh`  **Domain:** `starberkeley.org`
- **Path:** empty
- **Service URL:** `ssh://host.docker.internal:22`
- Save.

The `ssh://` scheme is what makes it an SSH route (no separate type field in the
new UI). `host.docker.internal` resolves to the host box because the
`cloudflared` service in `docker-compose.yml` maps it with `extra_hosts:
host-gateway`, so the container-side connector reaches the host's own `sshd` on
port 22. This is a DNS-less route — Cloudflare auto-creates the
`ssh.starberkeley.org` CNAME to the tunnel; you don't add an A record and no port
is opened on the box.

### 5b. Gate SSH behind Zero Trust Access (recommended — can add later)

**You can skip this at first and add it whenever.** Until it's in place, SSH is
still protected by your key (§3) and the box has no open ports — but *anyone*
who can run `cloudflared access ssh --hostname ssh.starberkeley.org` can reach
the `sshd` login prompt and take swings at it. Adding this puts a Cloudflare
login in front of that prompt so unapproved identities never even reach it. To
do it now:

1. **Zero Trust → Access → Applications → Add an application → Self-hosted.**
2. **Application name:** `star-apps SSH`.  **Session duration:** e.g. `24h`.
3. **Public hostname:** subdomain `ssh`, domain `starberkeley.org` (matches §5a).
4. **Add a policy** → Action **Allow**:
   - Name: `team`.
   - Include → **Emails** (specific admins) *or* **Emails ending in**
     `@berkeley.edu` — pick the tighter one you can. Add a second Include of
     type **Login Methods** if you want to force Google SSO.
5. Save. Now the first `ssh star-apps` of a session opens a browser for the
   Cloudflare login; only allowed identities get through to `sshd`, which then
   still checks your SSH key (§3). Two independent gates.

> **Short-lived SSH certs (optional, stronger).** Instead of relying on your
> static key behind Access, you can have Cloudflare issue a per-login SSH
> certificate: Access → **Service Auth → SSH**, generate the CA, then on the box
> add `TrustedUserCAKeys /etc/ssh/ca.pub` (the CA public key from the dashboard)
> and a `PubkeyAuthentication yes` block. Skip unless you want to stop managing
> `authorized_keys` — the §5b policy + key is already solid.

---

## 6. Deploy the stack

Follow [`README.md`](README.md) from **§2** onward. In short:

```bash
git clone --depth 1 --filter=blob:none --sparse -b landing-page \
  https://github.com/calstar/STAR.git
cd STAR
git sparse-checkout set deploy/apps        # brings the root compose + .env.example
cp .env.example .env
```

The `star-*` GHCR images are **public**, so no `docker login` / PAT is needed —
`docker compose pull` fetches them straight away. Fill `.env` (see README for the
full table):

| Var | Value |
| --- | --- |
| `JWT_SECRET` | **the same value as the EC2 auth** |
| `AUTH_VERIFY_ONLY` | `true` |
| `SCHEME` | `http` (Cloudflare terminates TLS) |
| `CLOUDFLARE_TUNNEL_TOKEN` | this machine's tunnel token (§5) |

Launch (the `tunnel` profile brings up `cloudflared`, which now carries both web
and SSH):

```bash
docker compose --profile tunnel pull
docker compose --profile tunnel up -d
docker compose ps
```

Because ingress is entirely through the tunnel, drop the host's published web
ports: remove the `80:80` / `443:443` lines from the `caddy` service (or block
them at the firewall — §1 already does). With SSH also on the tunnel, **nothing
inbound needs to be open.**

The stack restarts on boot on its own: every service uses
`restart: unless-stopped` and Docker is `enable`d (§4), so a reboot brings the
apps and the tunnel back up automatically.

---

## 7. Connect over SSH (from your laptop)

Install `cloudflared` locally (`brew install cloudflared`, or the Cloudflare apt
repo on Linux), then add to `~/.ssh/config`:

```
Host star-apps
  HostName ssh.starberkeley.org
  User star
  ProxyCommand cloudflared access ssh --hostname %h
```

Now `ssh star-apps` works from anywhere — no open ports, no VPN. The first
connection opens a browser for the Zero Trust Access login if you added the
policy in §5.

---

## 8. Verify

```bash
# From your laptop:
ssh star-apps 'docker compose ps'          # SSH over the tunnel
curl -sI https://engine-design.starberkeley.org/   # 302 → auth.../login (web over the tunnel)
```

Open `https://pid-designer.starberkeley.org` in a browser → it bounces to
`auth.starberkeley.org` to sign in → back to the app.

---

## Optional: durable version history in S3

Per-user P&ID / Engine / Recovery **version history** can live in versioned S3
buckets instead of only the local `userdata` volume. That setup (buckets, IAM,
lifecycle rules, `.env` keys) is in [`README.md`](README.md) — "P&ID diagram
versioning (S3)" and the section after it.
