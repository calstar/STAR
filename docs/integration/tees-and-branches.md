# Tees, branches, and where the flow splits

From the pid-designer side. The question this answers, asked plainly:

> A line carries a tally of fittings including a tee. Something else — a
> transducer, a vent, another leg of the system — comes off that tee. How does
> the line know *which* tee, and how is the flow through it solved?

The short answer is that the question contains the mistake, and naming the
mistake fixes the architecture:

> **A tee that carries flow to a third place is a node, not a fitting.**

---

## Why a flowing tee cannot be a fitting

A segment carries **one mass flow**. That is what makes `f·L/D + ΣK` a single
number: every fitting in it sees the same ṁ. The moment flow leaves by a third
leg, that is no longer true — there are three flows meeting, related by a mass
balance, and `feedtwin.solve.Network` needs a node with three branches on it.

So a tee in a segment's fitting tally means exactly one thing, and it is not
"there is a branch here":

| The third leg | What it is | Where it lives |
|---|---|---|
| Carries flow | A **node** | A junction on the drawing, three branches in the solve |
| Dead-ended | A **fitting** | `tee_run` in the tally; `DeadEnd` in the solve |

A transducer tap, a capped port, a shut relief valve: no flow, so no split. The
run sees a `tee_run` K and `feedtwin.solve` peels the stub off before solving,
which it already does and documents as the right thing.

## How the drawing says it

**The junction is the tee.** A line becomes two, with a node between them —
exactly the topology a three-branch node needs — and the third thing connects
to that node.

**Nobody has to place it.** Drag from the relief valve, let go on the line, and
the junction appears where you let go. That is the answer to "must somebody
draw a junction for every branch": a branch needs a node, but needing one is
not a reason to make anybody think about one. The Junction tool remains for
placing one deliberately on a line nothing is connected to yet, and both
gestures run the same code, so a drawing cannot tell you which was used.

That also answers "how does the line know which tee": it does not have to. The
tally never has to point at a fitting, because the branch is not in the tally.
The line ends at the junction and a new line starts after it.

### What each half of a split line carries

Worth stating because it decides whether a solve is right. Splitting a run does
not copy it:

| | On a split | Why |
|---|---|---|
| Bore, roughness, line type | **Both halves** | Intensive — true of any length of that pipe |
| Length, lumped K, fitting tally | **Upstream half only** | Extensive — the pair has to still add up to the run |

The downstream half starts *unstated*, which here means not stated, never zero
— so feed-twin defaults it and its run report counts it unchecked, rather than
believing a zero nobody typed. Deleting the junction concatenates the two
halves back in order, so putting a junction in and taking it out is a round
trip and not a slow leak of stated geometry.

A junction is no longer an anonymous dot. It now carries:

```ts
params:  bore, branch_bore
options: teeKind    // equal | reducing | cross | weldolet
         branchPort // auto | t | r | b | l
```

## What the drawing will not tell you, on purpose

**The K of a tee.** Crane and Idelchik both give a tee's loss as a function of
the *flow ratio* through it — how much goes down the branch versus the run. That
ratio is an output of the solve, not an input to the drawing. If pid-designer
stored a tee K it would be storing a number that is only correct for one
operating point, and it would look as authoritative as a measured one.

So the split is:

- **pid-designer supplies geometry**: bore, branch bore, which leg is the
  branch, what kind of tee.
- **feed-twin supplies the K**, per iteration, from that geometry and the flow
  ratio it has just solved.

This is the same boundary as everywhere else — the drawing owns what is true
about the hardware, the twin owns what is true about the operating point.

## Which leg is the branch

A junction has four ports (`t`, `r`, `b`, `l`) and typically three in use. The
branch is the odd one out: the two roughly collinear legs are the run.

`branchPort: 'auto'` means *work it out from which ports have lines on them* —
the two opposite ones are the run, the remaining one is the branch. That is
right almost always and wrong for a cross, or for a tee drawn at an angle, so
it can be stated instead.

**Please implement `auto` the same way** — opposite pair is the run — so a
drawing and a solve never disagree about which leg is which. If you would
rather it always be explicit, say so and I will drop `auto` and make the field
required.

## The double-count, again

If a junction sits on a line **and** the adjacent segment's tally also counts a
`tee_run` or `tee_branch` for that same tee, the tee is paid for twice. Same
class of error as adding a fitting's body length to the pipe length.

pid-designer will add a check for it: *"SOL-3 → junc_4 counts a tee, and there
is a junction at that end — one of them is the same tee twice."* Worth
mirroring on your side as a warning at import, since a drawing that predates
the check can still arrive.

## What I need from feed-twin

1. **Read `JUNCTION` nodes as three-branch (or four-branch) network nodes**,
   with a per-path loss from `bore`, `branch_bore`, `teeKind` and the solved
   flow ratio. Today they are, I think, treated as plain nodes with no loss —
   which is a real omission, because a branch tee is often the largest single K
   in a manifolded run.

2. **Confirm the `auto` branch-leg rule** above, or ask me to make it explicit.

3. **`cross` and `weldolet`** as tee kinds, if you want them priced
   differently. A cross is two tees back to back for loss purposes and a
   weldolet is closer to a sharp branch entry, but you own that call.

4. **Say what happens to a junction with only two legs.** Somebody will drop
   one mid-line and never branch it. It should be a pass-through with no loss
   rather than an error — but confirm, because right now the drawing lets it
   happen and I would rather it be harmless by design than by accident.

## What pid-designer will do next

- The check above, for a tee counted twice.
- A junction with a stated bore draws at that bore in the flow-path picture, so
  a branch shows up in the same drawing as the rest of the run.

Since the first draft of this document: branching by dropping a connection on a
line, **dropping a transducer or a gauge on a line** (they have one port, so
the gesture is unambiguous — it splits the run and hangs the instrument off the
junction), rejoining the run when a mid-line junction is deleted, and the
extensive / intensive split above are all in. Point 4 below matters more
because of those — a two-legged junction is now something people will make by
accident.
