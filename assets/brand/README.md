# Shared brand assets

**Single source of truth for STAR brand imagery.** Edit the files *here* — nowhere
else.

Each frontend builds its Docker image from its own subdirectory as the build
context (e.g. `context: ./landing`), so a build can't reach up into this folder.
To work around that, `scripts/sync-brand.sh` copies these masters into each
consuming app's local `src/assets/`. Those copies are committed (so the isolated
Docker builds can see them) but are **generated** — do not hand-edit them.

## Workflow

1. Change a file in this folder.
2. Run `scripts/sync-brand.sh` from the repo root.
3. Commit this folder **and** the updated copies it wrote.

## Adding a new consumer

Add its `src/assets` path to the `CONSUMERS` list in `scripts/sync-brand.sh`,
then run the script.

## Files

- `star-wordmark.png` — full STAR wordmark, dark/transparent (for dark headers).
  Synced into each consuming app's `src/assets/` and imported by React.
- `star-icon.svg` — browser-tab favicon: just the white STAR rocket logo on a
  transparent background, cropped tight to the rocket. Crisp on dark tabs, nearly
  invisible on light tabs (an accepted tradeoff for now). Synced into each app's
  `public/` and referenced from `index.html` as `/star-icon.svg`. Generated from
  `star-logo-white.png` by `scripts/make-star-icon.mjs` — do not hand-edit; rerun
  that then `sync-brand.sh`.
- `star-logo-white.png` — white STAR rocket logo, transparent background. Source
  for `star-icon.svg` only (not synced to apps on its own).
