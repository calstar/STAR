# OpenRocket's icons

Copied unchanged from OpenRocket release-24.12,
`swing/src/main/resources/pix/` (`componenticons/`, `icons/`, `eventicons/`,
and three sizes of `icon/`), so the workbench shows the same glyphs as
OpenRocket itself.

OpenRocket is GPLv3, and so is openrocket-web (`../../../../LICENSE`). Most of
`icons/` comes from the Nuvola set by David Vignoni (LGPL); see
`icons/copyright.txt` and `eventicons/copyright.txt` for the per-file credits.

`../fonts/Inter-Variable.ttf` is the Inter font OpenRocket ships and registers
(`swing/src/main/resources/fonts/Inter/`), under the SIL Open Font License
(`../fonts/OFL.txt`).

They live under `src/`, not `public/`, so that they go through Vite's module
graph: `src/workbench/icons.ts` imports every icon with `import.meta.glob`, and
`src/workbench/openrocket.css` names the font by a relative `url()`. Whichever
app compiles the workbench -- this one standalone, or star-openrocket, which
mounts it as its OpenRocket tab -- bundles them itself, so nothing has to be
copied into a host's `public/`.
