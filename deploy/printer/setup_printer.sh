#!/usr/bin/env bash
#
# STAR print server setup — Brother HL-2270DW over USB, shared to the tailnet.
#
# The printer hangs off this box by USB with its own Wi-Fi switched off, so it
# never touches the school network. CUPS drives it locally with brlaser and
# publishes one queue over Tailscale. Tailnet membership is the only gate —
# there are no CUPS passwords and no Unix accounts, so a laptop on the tailnet
# can print and anything else is refused at the door.
#
#   laptop ──tailscale──▶ star-rfs:631/printers/brother ──USB──▶ HL-2270DW
#
# Run it on the print server:
#
#     sudo bash deploy/printer/setup_printer.sh
#
# With a Tailscale auth key, to skip the interactive browser login:
#
#     sudo TS_AUTHKEY=tskey-auth-... bash deploy/printer/setup_printer.sh
#
# Safe to re-run: every step checks before acting (idempotent).
#
# Two things it deliberately does NOT do, because both are admin-console only.
# It prints a reminder for each at the end:
#   * disabling node key expiry — without it printing dies ~180 days later
#   * the optional tailnet ACL restricting :631 to named users
#
# See README.md in this folder for client setup and the gotchas.

set -euo pipefail

# ── Tunables (override via env) ──────────────────────────────────────────────
PRINTER="${PRINTER:-brother}"              # CUPS queue name; clients use printers/$PRINTER
TS_AUTHKEY="${TS_AUTHKEY:-}"               # optional, skips the browser login
TAILNET_CIDR="${TAILNET_CIDR:-100.64.0.0/10}"   # the whole Tailscale range — see note below
ADMIN_USER="${ADMIN_USER:-${SUDO_USER:-$(id -un)}}"

CONF=/etc/cups/cupsd.conf
BACKUP=/etc/cups/cupsd.conf.pre-printer-setup
BEGIN_MARK="# >>> STAR printer setup >>>"
END_MARK="# <<< STAR printer setup <<<"

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[1;32m   ok — %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mxx %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run me with sudo:  sudo bash $0"

# ── 1. Packages ──────────────────────────────────────────────────────────────
say "Step 1/6 — CUPS and the brlaser driver"
need_pkg=()
dpkg -s cups                  >/dev/null 2>&1 || need_pkg+=(cups)
dpkg -s printer-driver-brlaser >/dev/null 2>&1 || need_pkg+=(printer-driver-brlaser)
if ((${#need_pkg[@]})); then
  apt-get update -qq
  apt-get install -y "${need_pkg[@]}"
else
  ok "already installed"
fi
systemctl enable --now cups >/dev/null 2>&1 || true

# ── 2. lpadmin group ─────────────────────────────────────────────────────────
say "Step 2/6 — $ADMIN_USER in the lpadmin group"
if id -nG "$ADMIN_USER" | tr ' ' '\n' | grep -qx lpadmin; then
  ok "already a member"
else
  usermod -aG lpadmin "$ADMIN_USER"
  warn "$ADMIN_USER must log out and back in for the lpadmin group to take effect"
fi

# ── 3. Discover the printer and its PPD ──────────────────────────────────────
# Both of these are discovered rather than hardcoded, and that matters:
#   * the USB URI carries a per-unit serial and a URL-escaped model name
#     (usb://Brother/HL-2270DW%20series?serial=...), so it differs per printer
#   * the brlaser PPD for this model is br2270d.ppd, NOT br2270dw.ppd — an easy
#     thing to mistype, and lpadmin rejects a wrong PPD with "Bad PPD file"
say "Step 3/6 — locating the printer on USB"
URI="$(lpinfo -v 2>/dev/null | awk '/usb:.*[Bb]rother/ {print $2}' | head -1 || true)"
[[ -n "$URI" ]] || die "No Brother printer found on USB.
   Check the cable and that the printer is powered on, then:  lsusb | grep -i brother"
ok "device  $URI"

PPD="$(lpinfo -m 2>/dev/null | grep -i brlaser | grep -i 2270 | awk '{print $1}' | head -1 || true)"
[[ -n "$PPD" ]] || die "No brlaser PPD for the HL-2270DW found.
   Is printer-driver-brlaser installed?  Check with:  lpinfo -m | grep -i 2270"
ok "ppd     $PPD"

# ── 4. The queue ─────────────────────────────────────────────────────────────
say "Step 4/6 — CUPS queue '$PRINTER'"
# lpadmin -p both creates and modifies, so re-running just reasserts the config.
# It warns "Printer drivers are deprecated" on CUPS 2.4+; harmless, PPD support
# goes away in CUPS 3.x and this will need revisiting then.
lpadmin -p "$PRINTER" -v "$URI" -m "$PPD" -E -o printer-is-shared=true
lpadmin -d "$PRINTER"
ok "queue created and set as system default"

# ── 5. Tailscale ─────────────────────────────────────────────────────────────
say "Step 5/6 — Tailscale"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
if tailscale status >/dev/null 2>&1; then
  ok "already up as $(tailscale status --json | grep -o '"DNSName":"[^"]*"' | head -1 | cut -d'"' -f4)"
elif [[ -n "$TS_AUTHKEY" ]]; then
  tailscale up --auth-key="$TS_AUTHKEY"
  ok "joined the tailnet"
else
  warn "Not on the tailnet yet. Run this yourself, it needs a browser login:"
  warn "    sudo tailscale up"
  warn "Continuing — the CUPS side does not depend on it."
fi

# ── 6. cupsd.conf ────────────────────────────────────────────────────────────
say "Step 6/6 — CUPS network config"
[[ -f "$BACKUP" ]] || { cp "$CONF" "$BACKUP"; ok "backed up original to $BACKUP"; }

tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
cp "$CONF" "$tmp"

# Drop any block we wrote previously, so a re-run replaces rather than stacks.
sed -i "/^${BEGIN_MARK}\$/,/^${END_MARK}\$/d" "$tmp"

# Also drop a hand-written <Location /printers/$PRINTER> block from a manual
# setup predating this script. Without this, a first run on an already
# hand-configured box leaves two blocks for the same path.
sed -i -E "/^[[:space:]]*<Location[[:space:]]+\/printers\/${PRINTER}>/,/^[[:space:]]*<\/Location>/d" "$tmp"

# Drop every Listen/Port/ServerAlias directive, including the domain socket —
# the block below re-adds exactly one of each, so the result is deterministic
# no matter what the file looked like going in.
#
# This is load-bearing, not tidiness. CUPS cannot combine "Listen *:631" with
# an address-specific "Listen localhost:631": given both it keeps the specific
# one, drops the wildcard, and logs NOTHING. The daemon then answers only on
# loopback while the config plainly reads *:631 — a genuinely hard failure to
# spot, since it looks exactly like a network problem. See cupsd.conf(5).
sed -i -E '/^[[:space:]]*(Listen[[:space:]]+\S+|Port[[:space:]]+[0-9]+|ServerAlias[[:space:]]+\S+)[[:space:]]*$/d' "$tmp"

# Our block is prepended, so stripping it on a re-run leaves the blank line
# that trailed it at the top of the file. Drop leading blanks, or the file
# grows by one line every time this script runs.
sed -i '/./,$!d' "$tmp"

# Prepend our managed block.
{
  echo "$BEGIN_MARK"
  echo "# Managed by deploy/printer/setup_printer.sh — edits here are overwritten."
  echo "Listen *:631"
  echo "Listen /run/cups/cups.sock"
  echo ""
  echo "# Without this CUPS rejects any unfamiliar Host header with a bare"
  echo "# \"Bad Request\" and no explanation — which is what a client reaching"
  echo "# us by MagicDNS name sends."
  echo "ServerAlias *"
  echo ""
  echo "# Tailnet-only access to the queue. No CUPS or Unix auth by design:"
  echo "# being on the tailnet IS the credential. Allowing the whole Tailscale"
  echo "# range rather than this node's literal IP also dodges a boot race,"
  echo "# where cupsd starts before tailscaled has assigned the address and"
  echo "# then fails to bind."
  echo "<Location /printers/$PRINTER>"
  echo "  Order deny,allow"
  echo "  Deny from all"
  echo "  Allow from $TAILNET_CIDR"
  echo "  Allow from localhost"
  echo "</Location>"
  echo "$END_MARK"
  echo ""
  cat "$tmp"
} > "$tmp.new" && mv "$tmp.new" "$tmp"

# Validate before installing — a bad config means cupsd won't come back up.
if ! cupsd -t -c "$tmp" >/dev/null 2>&1; then
  cupsd -t -c "$tmp" || true
  die "Generated config failed cupsd's own syntax check; $CONF left untouched."
fi

install -m 0640 -o root -g lp "$tmp" "$CONF"
systemctl restart cups
ok "config installed and cups restarted"

# ── Verify ───────────────────────────────────────────────────────────────────
# "systemctl is-active" is not a check — it says "active" for a daemon that
# came up bound to loopback only. The bind address is the thing to assert.
say "Verifying"
fail=0
if ss -ltn 2>/dev/null | grep -qE '(0\.0\.0\.0|\*):631'; then
  ok "cupsd listening on all interfaces"
else
  warn "cupsd is NOT listening on 0.0.0.0:631 — clients will not reach it:"
  ss -ltn | grep 631 || true
  fail=1
fi

TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
if [[ -n "$TS_IP" ]]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$TS_IP:631/printers/$PRINTER" || echo 000)"
  if [[ "$code" == "200" ]]; then
    ok "queue answers 200 over the tailnet at $TS_IP"
  else
    warn "queue returned HTTP $code over the tailnet (expected 200)"
    fail=1
  fi
fi

lpstat -p "$PRINTER" >/dev/null 2>&1 && ok "queue '$PRINTER' is present and enabled"

# ── What only a human can do ─────────────────────────────────────────────────
DNSNAME="$(tailscale status --json 2>/dev/null | grep -o '"DNSName":"[^"]*"' | head -1 | cut -d'"' -f4 | sed 's/\.$//' || true)"
cat <<EOF

$(printf '\033[1;36m== Left for you, in the Tailscale admin console\033[0m')

  1. DISABLE KEY EXPIRY on this node (Machines -> ${DNSNAME:-this host} -> ... ).
     Not optional. Node keys expire after ~180 days, and when it happens the
     box drops off the tailnet and printing stops with nothing in any log that
     points at the cause.
$( [[ -n "$TS_AUTHKEY" ]] && printf '\n  2. REVOKE the auth key you passed to this script (Settings -> Keys).\n     It is now in your shell history and in this terminal'"'"'s scrollback.\n' )
  $( [[ -n "$TS_AUTHKEY" ]] && echo 3 || echo 2 ). Optional ACL, to narrow :631 from "any tailnet device" to named users:

       "acls": [
         {"action": "accept", "src": ["aidan@", "inez@"], "dst": ["${DNSNAME%%.*}:631"]}
       ]

$(printf '\033[1;36m== Client setup\033[0m')

  Address the queue explicitly. Discovery will never find it: mDNS and WSD are
  broadcast protocols and a tailnet is routed, not bridged.

  macOS    Printers & Scanners -> Add -> IP tab
           Address   ${DNSNAME:-<magicdns-name>}
           Protocol  IPP
           Queue     printers/$PRINTER

  Windows  Add device -> let the search fail -> Add manually
           -> "Select a shared printer by name"
           http://${DNSNAME:-<magicdns-name>}:631/printers/$PRINTER
           Driver: Microsoft -> "Microsoft PS Class Driver" (generic PostScript).
           NOT Brother's own HL-2270DW driver — see README.

  Neither will prompt for a username or password. If one does, the Location
  block above did not take.

EOF

exit $fail
