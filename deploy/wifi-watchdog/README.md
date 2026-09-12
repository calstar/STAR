# Keeping the test stand's Wi-Fi up

The TP-Link USB adapter on the DAQ box drops off the network and only comes
back when someone physically unplugs it. This directory fixes the cause and
adds a watchdog that does the replug in software when it happens anyway.

## What actually goes wrong

The adapter is an **RTL8822BU** (`2357:0138`) on the in-tree `rtw88_8822bu`
driver, presenting as `wlx0cef15768c39`.

When the link goes idle the chip enters its hardware **IPS** state — "Inactive
Power Save". Sometimes it does not come back out, and the driver has no way to
force it. From then on, every `wpa_supplicant` scan attempt produces this, once
every ~15 seconds, forever:

```
rtw88_8822bu 4-4:1.0: error beacon valid
rtw88_8822bu 4-4:1.0: failed to download rsvd page
rtw88_8822bu 4-4:1.0: failed to download firmware
rtw88_8822bu 4-4:1.0: leave idle state failed
rtw88_8822bu 4-4:1.0: failed to leave ips state      <-- the actual fault
rtw88_8822bu 4-4:1.0: failed to leave idle state
```

**`failed to download firmware` is a red herring.** The firmware file is
present and fine (`/lib/firmware/rtw88/rtw8822b_fw.bin.zst`), and it loads
cleanly as version 30.20.0 every time the chip is awake. It only fails here
because you cannot push firmware into a chip that is asleep and unresponsive.
Chasing the firmware message leads nowhere; the line to grep for is
`failed to leave ips state`.

Unplugging works because it power-cycles the silicon. On 2026-09-12 you can
watch exactly that:

```
11:47:04  usb 4-4: USB disconnect, device number 5
11:47:08  usb 4-4: new SuperSpeed USB device number 6 using xhci_hcd
11:47:08  rtw88_8822bu 4-4:1.0: Firmware version 30.20.0, H2C version 14
11:47:15  wlx0cef15768c39: associated
```

Clean firmware load, associated seven seconds later.

The trigger is Wi-Fi power saving, which Ubuntu enables by default:

```
/etc/NetworkManager/conf.d/default-wifi-powersave-on.conf:  wifi.powersave = 3
```

## The two halves of the fix

**Stop it happening** — `zz-wifi-powersave-off.conf` sets `wifi.powersave = 2`
(disabled). No power save, no IPS state to get stuck in. This is the real fix
and it is the reason the watchdog should mostly have nothing to do.

**Recover when it happens anyway** — `tplink-wifi-watchdog` runs every minute,
looks for the wedge signature in the kernel log, and re-enumerates the adapter.

A keepalive ping would *not* work here, which is worth saying plainly: once the
chip is wedged, traffic just generates more failed wake attempts. That 15-second
log spam already *is* the system trying and failing to talk to it. The only
thing that recovers it is re-enumeration.

## How the watchdog recovers the adapter

It escalates, cheapest first, and checks whether the adapter came back before
escalating further:

1. **`usbreset`** — a USBDEVFS_RESET ioctl. A bus reset; the device stays bound
   to the driver. Least disruptive, usually enough.
2. **Cycle the port** — `echo 1 > usb4-port4/disable`, wait, `echo 0`. This
   drops the port *electrically*, which is as close to pulling the plug as
   software gets.

Step 2 is deliberately a port disable rather than the more commonly suggested
`echo 0 > authorized`. Deauthorizing only detaches the device *logically* and
leaves VBUS up, so it does not reliably clear a fault in the chip's own power
state machine. The `authorized` toggle is kept only as a fallback for ports
with no `disable` node.

### Verified, 2026-09-12

Step 2 was tested against a live adapter. It is a genuine drop, not a logical
detach — the port reported `state=not attached` and the device node
disappeared, exactly as a physical unplug does:

```
12:24:35  disabling port ...
12:24:36  port disabled. port state=not attached
12:24:36    device node gone — port genuinely dropped, as a replug would
12:24:39  re-enabling port ...
12:24:51  RECOVERED after 11s
```

with a clean re-enumeration and firmware load in the kernel log:

```
12:24:35  usb 4-4: USB disconnect, device number 6
12:24:36  rtw88_8822bu 3-4:1.0: Firmware version 30.20.0, H2C version 14
12:24:51  wlx0cef15768c39: associated
```

Two things that test taught us, both now handled in the script:

**The adapter changes bus across a reset.** It came back as `3-4` (USB 2), not
`4-4` (USB 3 SuperSpeed) — `rtw88_usb` is built with `switch_usb_mode=Y`. The
port to cycle moved from `usb4-port4` to `usb3-port4` with it. This is why the
watchdog resolves the device by vendor:product and derives the port path every
run; anything pinned to `4-4` would already be broken.

**Associated is not the same as usable.** At the instant the adapter reported
`Connected to ...`, the default route was still empty and pings failed — DHCP
finishes a beat later. The watchdog now logs the route coming back separately,
and does not treat its absence as a failed recovery.

The 11 seconds included an unrelated eduroam hiccup: the first AP rejected the
association temporarily (`status=30`, 5s comeback) and it roamed to another.
A clean cycle is nearer 7s.

**Still unproven:** this test ran against a *healthy* adapter, so it shows
re-enumeration works — not that it clears the IPS wedge specifically. That can
only be confirmed on a wedged adapter. Next time it happens, run
`sudo tplink-wifi-watchdog --now` and check the journal.

Two guards keep it from making things worse:

- **Cooldown (180s).** If a reset did not help, cycling the port every 60s
  turns one dead adapter into a reboot loop. After a reset it backs off and
  lets a human look.
- **Located by vendor:product, never by `4-4`.** Moving the adapter to another
  port, or a re-enumeration handing it a new device number, does not break the
  watchdog. The port path is derived from wherever the device actually is.

`70-tplink-8822bu-power.rules` is belt-and-braces: it pins USB autosuspend off
for this device. The node currently reads `power/control=on`, but that is not
sticky — after any re-enumeration, including the watchdog's own, it reverts to
the bus default of `auto`.

## Install

```bash
sudo ./install.sh
```

Idempotent, and `sudo ./install.sh --uninstall` puts everything back. It does
**not** restart NetworkManager — that would bounce every connection on the box,
including the one you are probably using to read this. It reloads config and
applies the change to the live interface instead.

## Day to day

```bash
sudo tplink-wifi-watchdog --status    # health, change nothing
sudo tplink-wifi-watchdog --now       # force a reset, instead of reaching behind the box
journalctl -t tplink-wifi-watchdog -f # watch it work
systemctl status tplink-wifi-watchdog.timer
```

A healthy adapter looks like:

```
device:    4-4
interface: wlx0cef15768c39
portdir:   /sys/bus/usb/devices/usb4/4-0:1.0/usb4-port4
operstate: up
powersave: off
link:      Connected to 80:8d:b7:fa:21:92 (on wlx0cef15768c39)
state:     healthy
```

If `powersave` still reads `on` after installing, the connection has not been
reactivated yet — NetworkManager applies the setting at activation time. The
installer sets it on the live interface too, so this should be rare.

## Note on where this lives

Every other unit in this repo is a **user** unit under
`~/.config/systemd/user` (see `daq-server/deploy/systemd/`). This one is a
**system** unit in `/etc/systemd/system`, because it writes to
`/sys/bus/usb/devices/*/authorized` and `usb*-port*/disable`, which a user unit
cannot touch. It is installed by `./install.sh` here, not by
`daq-server/deploy/systemd/install_services.sh`.

## If the watchdog stops being enough

Two escalations, in order:

- **Reboot.** The box has run 34+ days. The wedge first appeared 2026-09-11 at
  12:49 with no matching driver or kernel update that day (only `wireless-regdb`
  and `libperl5.40`), which points at accumulated driver state rather than a
  regression.
- **Replace the adapter, or go wired.** `rtw88` USB support for the 8822BU has
  a long history of exactly this bug. The DAQ box has a working Gigabit NIC
  (`enp4s0`, `r8169`); for anything that matters during a run, use it.

The onboard Realtek PCIe card (`wlp3s0`, RTL8192EE) is **not** a fallback — it
never initializes (`rtl8192ee: Polling FW ready fail!!`) and sits in
`unavailable`, which is why it finds no networks. Deliberately out of scope
here.
