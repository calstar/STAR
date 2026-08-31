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
the host must fall back to `index.html` for unknown paths (SPA rewrite).

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
