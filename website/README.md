# STAR public website

The public marketing site for UC Berkeley's Space Technologies and Rocketry —
Home, Projects (launch-history timeline), Leads, Sponsors, and Join.

Built with **React 19 + Vite + Tailwind v4 + TypeScript** and `react-router`.
Dark, cinematic design language. (This is separate from `../landing`, which is
the gated *internal-tools* portal.)

## Develop

```bash
./dev.sh            # http://localhost:5176  (installs deps on first run)
# or:
npm install
npm run dev
```

## Build (static)

```bash
npm run build       # → dist/  (static files; serve on any host)
npm run preview     # preview the production build locally
```

`dist/` is a fully static bundle. Because the site uses client-side routing,
the host must fall back to `index.html` for unknown paths (SPA rewrite). That
fallback ships as `public/.htaccess` (Apache) — Vite copies it into `dist/`.

## Deploy (OCF)

The public site is hosted on OCF and served from the account's web root, which
`~/public_html` symlinks to (e.g. `~/public_html -> /services/http/users/s/space`).
**Apache serves the symlink target** — don't replace the symlink with a real
folder, or your build lands somewhere Apache never reads.

One-time setup on the OCF account (sparse-checkout of just `website/`):

```bash
git clone --filter=blob:none --sparse https://github.com/calstar/STAR.git ~/star
cd ~/star && git sparse-checkout set website
git checkout public-website   # or `main` once merged
```

Then deploy (and redeploy) with one command — it pulls, builds, and rsyncs
`dist/` into `~/public_html` (following the symlink into the served dir):

```bash
~/star/website/deploy-ocf.sh
```

If the `public_html` symlink is ever missing, recreate it (match your account's
target): `ln -sfn /services/http/users/s/space ~/public_html`.

## Editing content

All copy and data live in `src/data/` — no component edits needed for routine
updates:

| File              | What it holds                                             |
| ----------------- | --------------------------------------------------------- |
| `projects.ts`     | Launch history + "Currently Building". Timeline reads this. |
| `leads.ts`        | Team roster. **Currently placeholders** — swap `name`/`bio` and add headshots to `public/img/leads/<id>.jpg`. |
| `sponsors.ts`     | Sponsor logos + links. Drop logos in `public/img/sponsors/`. |
| `subteams.ts`     | Subteam grid (Home) + descriptions (Join).                |
| `site.ts`         | Links, socials, contact email, headline stats.            |

Key external links (`apply.starberkeley.org`, `donate.starberkeley.org`) are in
`src/data/site.ts`.

## Assets

Photos live in `public/img/` (ported from the previous site). Add new images
there and reference them by absolute path, e.g. `/img/projects/foo.jpg`.
