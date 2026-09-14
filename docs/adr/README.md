# Architecture decision records

An ADR records a decision that was expensive to make and would be expensive to
reverse — what was chosen, what was rejected, and *why*, so that a year later
someone can tell the difference between a considered trade-off and an accident.

They are not design docs. A design doc says how something works and is kept up
to date; an ADR says why a fork in the road was taken and is **immutable once
accepted**. If a decision is later reversed, that is a new ADR that supersedes
the old one — the original stays, because the reasoning that turned out to be
wrong is the most useful part of the record.

## When to write one

Write an ADR when a choice:

- constrains more than one subproject, or
- would take more than a week to undo, or
- is one someone will predictably re-litigate ("why isn't this just a service?").

Ordinary implementation choices do not need one. If the code answers the
question, the code is the answer.

## Index

| # | Title | Status |
|---|---|---|
| [0001](0001-feed-system-physics-is-a-library.md) | Feed system physics is a library, not a service | Accepted |
| [0002](0002-the-drawing-is-a-shared-document.md) | The drawing is a shared document, not a feature of one app | Proposed |

## Format

Numbered `NNNN-kebab-case-title.md`, with the sections used in 0001: Status,
Context, Decision, Consequences, Alternatives considered. Keep it short — an
ADR nobody finishes reading records nothing.
