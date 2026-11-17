# OpenRocket's icons

Copied unchanged from OpenRocket release-24.12,
`swing/src/main/resources/pix/` (`componenticons/`, `icons/`, `eventicons/`,
and three sizes of `icon/`), so the workbench shows the same glyphs as
OpenRocket itself.

OpenRocket is GPLv3, and so is openrocket-web (`../../../LICENSE`). Most of
`icons/` comes from the Nuvola set by David Vignoni (LGPL); see
`icons/copyright.txt` and `eventicons/copyright.txt` for the per-file credits.

`../fonts/Inter-Variable.ttf` is the Inter font OpenRocket ships and registers
(`swing/src/main/resources/fonts/Inter/`), under the SIL Open Font License
(`../fonts/OFL.txt`).

When this app is mounted as a tab of star-openrocket, copy `public/pix/` and
`public/fonts/` into that app's `public/` as well (the workbench resolves them
against Vite's `BASE_URL`; the font against `/fonts/`).
