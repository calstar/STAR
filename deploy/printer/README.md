# The lab printer, shared over Tailscale

A Brother HL-2270DW hangs off the print server by **USB**, with its own Wi-Fi
switched off so it never touches the school network. CUPS drives it locally
with `brlaser` and publishes exactly one queue to the tailnet.

```
laptop ──tailscale──▶ star-rfs:631/printers/brother ──USB──▶ HL-2270DW
         (the gate)          (CUPS + brlaser)
```

## How access works

There are no CUPS passwords and no Unix accounts. **Being on the tailnet is the
credential.** CUPS' default policy already lets `Print-Job` through without
authenticating, so the only thing standing in front of the queue is an address
check:

```
<Location /printers/brother>
  Order deny,allow
  Deny from all
  Allow from 100.64.0.0/10     # the Tailscale range
  Allow from localhost
</Location>
```

Anything arriving from the tailnet prints. Anything else is refused. No client
should ever see a credential prompt — **if one does, that block isn't in
force**, and the fix is to look at the config, not to go find a password.

Two consequences worth being deliberate about:

- Port 631 is open on *every* interface, school LAN included. Requests arriving
  there are refused (`<Location />` is deny-by-default and the queue is
  IP-gated), but the port does answer. To close it off properly, restrict it to
  the Tailscale interface with `ufw allow in on tailscale0 to any port 631` plus
  a deny elsewhere — but see the boot-race note in the gotchas before pinning
  anything to a literal Tailscale address.
- Any device on the tailnet can print, not just people. Narrow that with the
  optional ACL below if it matters.

## Setup

On the print server:

```bash
sudo bash deploy/printer/setup_printer.sh
```

To skip Tailscale's interactive browser login, pass a pre-auth key (revoke it
afterwards — it lands in your shell history):

```bash
sudo TS_AUTHKEY=tskey-auth-... bash deploy/printer/setup_printer.sh
```

It is idempotent; re-run it to reassert config on a box that has drifted. Env
knobs: `PRINTER` (queue name, default `brother`), `TS_AUTHKEY`, `TAILNET_CIDR`,
`ADMIN_USER`.

| Step | What it does |
| --- | --- |
| 1 | Installs `cups` and `printer-driver-brlaser` |
| 2 | Adds the admin user to `lpadmin` |
| 3 | **Discovers** the USB device URI and the brlaser PPD rather than hardcoding either |
| 4 | Creates the `brother` queue, shared, as system default |
| 5 | Installs Tailscale and brings it up (auth key optional) |
| 6 | Rewrites the `Listen`/`ServerAlias`/`<Location>` directives in `cupsd.conf`, validates with `cupsd -t` before installing, restarts CUPS |

Step 3 is discovery rather than constants on purpose. The USB URI carries a
per-unit serial and a URL-escaped model name
(`usb://Brother/HL-2270DW%20series?serial=…`), and the PPD is `br2270d.ppd` —
**not** `br2270dw.ppd`, which is the name everyone reaches for and which
`lpadmin` rejects with a bare "Bad PPD file".

Step 6 rewrites rather than appends, and keeps its work between
`# >>> STAR printer setup >>>` markers. It strips any hand-written block for
the same path first, so running it on a box that was set up by hand converges
instead of producing two conflicting `<Location>` blocks. The original config
is saved once to `/etc/cups/cupsd.conf.pre-printer-setup`.

## Left to a human

Neither of these can be done from the CLI.

1. **Disable key expiry** on the node — Tailscale admin console → Machines →
   the print server → ⋯ → Disable key expiry. Do it the day you set the box up.
   Node keys expire after ~180 days, and when it happens the server silently
   drops off the tailnet and printing stops with nothing in any log pointing at
   the cause.
2. **Optional ACL**, to narrow port 631 from "any tailnet device" to named
   people:

   ```json
   "acls": [
     {"action": "accept", "src": ["aidan@", "inez@"], "dst": ["star-rfs:631"]}
   ]
   ```

## Client setup

Address the queue **explicitly**. Discovery will never find it — mDNS and WSD
are broadcast protocols, and a tailnet is routed, not bridged. Waiting for the
printer to appear in a search list is a dead end on every OS.

Get the MagicDNS name with `tailscale status` on the server.

**macOS** — Printers & Scanners → Add → **IP** tab

| Field | Value |
| --- | --- |
| Address | `star-rfs.<tailnet>.ts.net` |
| Protocol | IPP |
| Queue | `printers/brother` |

**Windows** — Add device → let the search fail → **Add manually** → *Select a
shared printer by name*:

```
http://star-rfs.<tailnet>.ts.net:631/printers/brother
```

Windows then asks for a driver, which is expected and is the step most likely
to go wrong. Pick **Microsoft → "Microsoft PS Class Driver"** (or
**Generic → "MS Publisher Imagesetter"**). If the manufacturer list is short,
click *Windows Update* to load the full set; it takes a few minutes and looks
frozen while it works.

**Do not pick Brother's HL-2270DW driver**, even though it's in the list and
looks like the obviously right answer. It's host-based: it renders to the
printer's private raster format on the PC. This queue expects PostScript or
PDF and runs brlaser itself, so it would re-render already-rendered data. The
driver you choose on the client only decides what gets sent over the network —
the real printer driver is `brlaser`, on the server.

## Verifying

`systemctl is-active cups` is **not** a check. It reports `active` for a daemon
that came up bound to loopback only, which is exactly the failure mode below.
Assert the bind address instead:

```bash
ss -ltn | grep 631                       # want 0.0.0.0:631, not 127.0.0.1:631
curl -o /dev/null -w '%{http_code}\n' \
  "http://$(tailscale ip -4):631/printers/brother"    # want 200
echo "hello" | lp -d brother             # local path, no network involved
```

Run the `lp` test first when something breaks. If it doesn't print, the problem
is the printer or the driver and nothing about the network matters yet.

## Gotchas

| Symptom | Cause |
| --- | --- |
| Config says `Listen *:631`, `ss` says `127.0.0.1:631` | A `Listen localhost:631` line is still present. CUPS **cannot combine** wildcard and address-specific `Listen` directives — given both it keeps the specific one, drops the wildcard, and logs nothing at all. See `cupsd.conf(5)`. |
| Bare "Bad Request" from CUPS | Missing `ServerAlias *`. CUPS rejects `Host` headers it doesn't recognise, and a client connecting by MagicDNS name sends one. |
| Works, then dies ~6 months later | Node key expiry was never disabled. |
| `cupsd` fails to start after a reboot | `Listen` pinned to the literal Tailscale IP. `cupsd` starts before `tailscaled` has assigned it and can't bind. Allow the `100.64.0.0/10` range in `<Location>` instead and listen on `*`. |
| `lpadmin: Bad PPD file` | Used `br2270dw.ppd`. The real name is `br2270d.ppd`; let the script discover it. |
| Prints garbage, or nothing | Client is using Brother's own Windows driver instead of a generic PostScript one. |
| Printer never shows up in the client's "add printer" search | Expected. mDNS/WSD don't cross a tailnet; address the queue by URL. |
| Client asks for a username and password | The `<Location>` block isn't in force. There is no correct password to type. |
