# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Propulsion (and adjacent) Cal STAR team members drawing and maintaining the
propulsion feed system's P&ID (tanks, valves, sensors, lines) — usually the
same people preparing for a hotfire test who need the diagram to match what's
actually plumbed. Access is gated to current team members (`@berkeley.edu`).

## Product Purpose

Interactive node-graph editor for the propulsion P&ID, with per-user private
diagrams, automatic version history (autosave plus throttled microversions),
and explicit named releases — so the diagram of record survives edits without
needing a separate versioning discipline layered on top.

## Positioning

A purpose-built propulsion-component palette (not a generic diagramming tool)
with git-like versioning (autosave, microversions, releases) and
single-writer checkout semantics built in and shared with the sibling design
tools rather than reinvented. A team member can safely view any colleague's
diagram without risking a lock, and takes the pen only when they mean to.

## Operating Context

Local dev via `./dev.sh` (backend on :8001, frontend on :5174). In
production, identity comes from the `X-Auth-Email` header Caddy injects (no
login in dev — everything belongs to a `local` user). Storage is a per-user
autosaved working copy on a volume, S3-versioned microversions, and S3
releases, built on the shared design core in `lib/stardesign`.

## Capabilities and Constraints

React Flow canvas plus a propulsion-component palette (16 catalog entries
across Sensors, Valves, Flow Control, Hardware, Supplies, and Annotation —
grown substantially by PR #57, "pid-designer overhaul, feed-twin and the
physics library into the tree," merged 2026-09-13). That overhaul added, on
top of the original single-canvas editor: multi-page/sheet support with a
title block, a centerline/manifold editor, catalog-driven regulator/valve/
check-valve edit dialogs (materials, burst pressure, temperature presets),
relief/check-valve/engagement validation checks, copy/paste/duplicate, and
PNG/SVG export alongside the JSON export. Editing is checkout-gated: viewing
a diagram never blocks anyone, but editing requires taking the checkout,
which self-releases after 15 minutes idle or on tab close. Sharing is a
whole-list replace, not an additive delta. Deliberately **no delete** — only
a server-admin volume cleanup can remove a diagram — because diagrams are
shared, editable group artifacts.

## Brand Commitments

Cal STAR internal-tools identity; shared design-tool chrome (Change dialog,
checkout chip) from `lib/stardesign-ui` — no distinct branding of its own
beyond that.

## Product Principles

- Viewing never blocks editing for someone else — read access and write
  access are deliberately different gates.
- No delete, ever — a shared diagram's only path to disappearing is an
  explicit admin operation, never a misclick.
- Version history is automatic, not a discipline the user has to remember to
  exercise.

## Accessibility & Inclusion

None established.
