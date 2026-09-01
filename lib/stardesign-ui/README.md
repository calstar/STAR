# stardesign-ui

The client half of design sharing, shared by EngineDesign, pid-designer and
recovery-calculator. The server half is [`lib/stardesign`](../stardesign).

Each app used to carry its own copy of the Change dialog, the modal shell and
the design API client. They were near-identical — the Change dialog differed
between two of the apps by **16 lines, every one of them an import path or a
type name**. This is that code, once.

## What's here

| Module | What it owns |
|---|---|
| `api.ts` | The design API client. `createDesignApi<T>` is the mirror of `DesignStore` on the backend: the apps differ only in route prefix and payload shape, so those are its parameters. Also `keyOf`/`refOf` — a design is addressed by `(owner, id)`, never `id` alone. |
| `ChangeModal.tsx` | The Change dialog: editable list, the view-only tree, the share picker, rename, leave, copy. |
| `Modal.tsx` | The dialog shell everything that would otherwise be a `window.confirm` is built on. |
| `useCheckout.ts` | The client half of checkouts: current holder, Take/Release, the poll that runs only while you *don't* hold it, and the release-on-tab-close beacon. |
| `CheckoutControl.tsx` | The status chip (*Editing* / *Alice is editing* / *Read only*) and its one button, plus `ReadOnlyNotice`. |
| `readOnly.tsx` | `ReadOnlyProvider` / `useDisabled`, so a leaf input knows the design is not checked out without a prop threaded through every panel. |
| `theme.ts` | Button classes and `relativeTime`. Separate from the components because react-refresh requires a component file to export nothing else. |

## What deliberately is not here

**The design bar itself, and read-only enforcement.** The one real difference
between the apps is where live design state lives, and it is not reconcilable:

| app | state lives in | an edit is noticed by |
|---|---|---|
| EngineDesign | a per-user **backend session** | a 4s poll of `GET /api/config` |
| recovery-calculator | React state in `App.tsx` + localStorage | a debounce on the `config` prop |
| pid-designer | ReactFlow state in the canvas | a debounce on `[nodes, edges]` |

So each app keeps its own bar and passes this package what it needs.

## Wiring an app up

Three files, and all three are load-bearing:

**`vite.config.ts`** — the alias, *plus a React pin*:
```ts
resolve: {
  alias: {
    '@stardesign-ui': fileURLToPath(new URL('../../lib/stardesign-ui/src', import.meta.url)),
    react:       fileURLToPath(new URL('./node_modules/react', import.meta.url)),
    'react-dom': fileURLToPath(new URL('./node_modules/react-dom', import.meta.url)),
  },
},
```
The React pin is not optional. This source sits outside the app, so Node
resolution walks up from it and never reaches the app's `node_modules`. Without
it the build fails with *"Rollup failed to resolve import react/jsx-runtime"*.

**`tsconfig.app.json`** — the same two problems for `tsc`: `paths` for
`@stardesign-ui` **and** for `react`/`react-dom` types, and `include` must list
`../../lib/stardesign-ui/src` or the shared code is never type-checked.

**`index.css`** — Tailwind only scans what it can reach from the project root:
```css
@source "../../../lib/stardesign-ui/src";
```
**This one fails silently.** Miss it and everything compiles, type-checks and
builds — the components just render unstyled. When changing this wiring, check a
shared class actually reaches the output (`grep 560px dist/assets/*.css`), not
just that the build passed. Note the emitted CSS escapes the brackets, so
grepping for `w-[560px]` finds nothing while `560px` finds it.

## Docker

Consumers build from the **repo root** so this directory is in the context, and
the builder stage mirrors the repo layout (`/build/app/frontend`, with the
shared source at `/build/lib`) so `../../lib/stardesign-ui` resolves the same
inside an image as in a checkout. See any `frontend/Dockerfile` and the
`.dockerignore`.

### Two things in `useCheckout` that exist to prevent data loss

1. **`take()` reloads before going editable.** Sitting in read-only while the
   holder saved leaves a stale view; editing from there would overwrite their
   work on the very first autosave.
2. **`lost()`** — a save can come back 423 because the checkout lapsed and
   someone else took it. The app must drop to read-only rather than retry into
   a void.

Read-only is enforced per app, because the editable surfaces have nothing in
common: recovery-calculator disables its shared input primitives,
pid-designer turns off ReactFlow's interaction props **and** checks the flag
inside `TextNode`/`DraggableLabel`, which edit via `useReactFlow().setNodes` and
so never see those props.
