---
version: 1
slug: "starproject-src-app-layout-tsx"
primary_target: "starproject/src/app/layout.tsx"
related_targets: ["starproject/src/app/page.tsx","starproject/src/components/AppHeader.tsx"]
---

## Direction contract

THESIS: Replace the single top-tab header with a persistent left-sidebar app
shell — Home / My tasks / Tasks / Projects / Subteams / Activity, plus live
project and subteam lists inline in the sidebar — so navigation and the
user's own priorities stay visible on every route, refusing the current
arrangement of one row of tabs above a generic tile-grid Home.

OWN-WORLD: Keep the existing neutral Tailwind system exactly as it already
renders — white/neutral-950 surfaces, neutral-200/800 borders, rounded-lg
cards, text-sm/2xl type scale, colored dots as project/subteam identity, the
existing STAR wordmark assets. No new palette or component language: a fixed
256px sidebar (sticky, full height, border-r) with the wordmark at top, the
primary nav list, a "Projects" section and a "Subteams" section each listing
real records with their real colors, and UserMenu (unchanged) pinned at the
bottom in place of its current header slot.

STORY: On any page the user always sees where they are and what else exists
(sidebar). On Home specifically, they see a greeting tied to the actual time
of day and their own name, then their own assigned tasks first (the biggest
panel — this is the reason they opened the app), then quick jumps into
Projects and Subteams. Nothing on Home is fabricated: no search, no
Insights/Portfolios/Goals, no invented stats, no fake collaborators — every
element reads from real Prisma data already queried by the current Home
page.

FIRST VIEWPORT: Desktop ≥1024px — sidebar (256px, full viewport height) to
the left, main column to the right. Main column: greeting header ("Tuesday,
September 19" / "Good afternoon, {first name}"), then a two-column area —
left column (wider, spans 2 of 3) holds the "My tasks" panel; right column
stacks "Projects" then "Subteams" panels, each titled with an "All →" link.
Mobile <1024px: sidebar becomes an off-canvas drawer behind a hamburger in a
slim sticky top bar (wordmark + compact avatar trigger); main content stacks
single-column, "My tasks" first.

FORM: Pinned by the user's own reference screenshot (Asana's Home) plus
their explicit scope answers (full app-shell replacement; omit
non-data-backed sections; no search yet). This extends the established
neutral-Tailwind world rather than opening a new identity — no concept-seed
roll.

FINISH: unreviewed and undocumented is unfinished; this build ends with the
finish review, the verdict, DESIGN.md, and every shipping raster carrying its
provenance. (No new raster assets ship in this build — dots and icons are
existing inline SVG/CSS, not images.)
