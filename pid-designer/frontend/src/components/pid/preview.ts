import { centreOfJunction, isJunction, reseatJunctions } from './junctions';
import { publishedLines } from './edgeGeometry';
import { drawnAfter } from './tracks';
import { pageOf } from './pages';
import { perPage } from './routeGrid';
import { commitDrop } from './drop';
import type { DropPlan, DropScene, PlanEnd } from './drop';
import { withoutSpendingIds } from './ids';
import type { Pt } from './route';

/**
 * What a drag shows before it is let go: the line letting go will draw.
 *
 * Both rubber bands used to draw something of their own. A port drag showed
 * React Flow's default curve and then committed an orthogonal route with
 * stubs and detours; a pull out of a line showed an L from the press to the
 * pointer, and out of a tee an L whose first leg lay along the tee's own run
 * -- while the branch it committed left across it, and a drop on a valve's
 * body committed a hook the L never hinted at. Nothing said whether the drop
 * would join a port, tee into a line, leave an open end, or do nothing at all.
 *
 * So a preview is the drop, made: `resolveDrop` says what letting go here
 * means, exactly as the drop handlers will ask it; `commitDrop` makes that,
 * on a copy nobody keeps; and the faces the new line ends on are chosen as
 * the reseat will choose them straight after the real drop (`pointLines`) --
 * an open end, above all, is put down facing back at where the line came
 * from and then turned to whichever face draws its line best, and a preview
 * of the first was half the time not the line that stayed. What is drawn is
 * that line, as the canvas will draw it -- routed as it routes itself, and
 * then moved off the lines already on the page, as the canvas moves it
 * (`tracks.drawnAfter`, from the lines as the page published them) -- with a
 * dot on each tee the drop puts in, a hollow one on an open end it leaves,
 * and a ring on the port or tee it joins. A drop that makes nothing is drawn
 * as the bare pull, faded: let go there and nothing happens.
 */
export interface PreviewShape {
  /** The route the line will be drawn along; for a drop that makes nothing, the pull as it stands. */
  points: Pt[];
  /** Where a new tee goes in (`open` false) or an open end is left (`open` true). */
  tees: { at: Pt; open: boolean }[];
  /** The port or tee the line joins, when it joins one that is already drawn. */
  ring: Pt | null;
  /** Letting go here makes nothing: the pull is too short, is back on its own pipe, or has nowhere to go. */
  cancel: boolean;
}

const cancelled = (pull: { from: Pt; to: Pt }): PreviewShape =>
  ({ points: [pull.from, pull.to], tees: [], ring: null, cancel: true });

/**
 * A plan, as the preview draws it: the line it makes, as the canvas will draw
 * it once the reseat has chosen its faces and the page has moved it off the
 * lines around it. `pull` is where the drag started and where the pointer is
 * now, drawn when the plan makes nothing.
 */
export function previewOf(plan: DropPlan, scene: DropScene, pull: { from: Pt; to: Pt }): PreviewShape {
  if (plan.kind === 'cancel') return cancelled(pull);
  const made = withoutSpendingIds(() => commitDrop(plan, scene));
  // The drawing will not take it (a stale plan): nothing happens.
  if (!made) return cancelled(pull);
  // The scene's own obstacles, or each page's symbols, remembered for the
  // drawing (`obstaclesByPage`): a drag previews against the same scene frame
  // after frame, and the boxes are the same until the drawing changes.
  const sheet = perPage(made.nodes, scene.obstacles);
  // Settled as the real drop is, whatever it joins. Not only for the faces
  // of a line that ends on a tee: a line between two ports is laid among the
  // lines the reseat chooses, which are chosen round it -- a branch whose
  // leg the new line's crossbar fell along takes another face -- and the
  // page moves the new line off them where they go. The reseat hands back
  // what it was given when nothing needs to move.
  const { nodes, edges } = reseatJunctions(made.nodes, made.edges, scene.endOf, sheet);
  const line = edges.find(e => e.id === made.lineId);
  // On the page it is drawn on, with the rest of that page as it has them.
  const upstream = line && nodes.find(n => n.id === line.source);
  const page = upstream && pageOf(upstream.data as { page?: string });
  const points = page && drawnAfter(scene, { nodes, edges }, page, scene.endOf, sheet, publishedLines()).get(line.id);
  if (!line || !points) return cancelled(pull);
  const before = new Set(scene.nodes.map(n => n.id));
  const tees: PreviewShape['tees'] = [];
  for (const n of nodes) {
    if (before.has(n.id) || !isJunction(n)) continue;
    const degree = edges.filter(e => e.source === n.id || e.target === n.id).length;
    tees.push({ at: centreOfJunction(n), open: degree <= 1 });
  }
  // A ring on what the line joins -- but not on an open end it joins, which
  // the line it ends goes on through and is gone once it has (`commitDrop`).
  const target = plan.to.kind === 'port' || plan.to.kind === 'tee' ? plan.to : null;
  const ring = target && nodes.some(n => n.id === target.nodeId) ? target.centre : null;
  return { points, tees, ring, cancel: false };
}

/** What makes two plans the same drop: where each end is and what it is on. */
function endKey(e: PlanEnd): string {
  const on = e.kind === 'port' ? `${e.nodeId}.${e.handle}`
    : e.kind === 'tee' ? `${e.nodeId}.${e.face}`
      : e.kind === 'split' ? `${e.edgeId}@${e.at.x},${e.at.y}.${e.face}` : e.face;
  return `${e.kind}:${on}:${e.centre.x},${e.centre.y}`;
}
export function planKey(plan: DropPlan): string {
  if (plan.kind === 'cancel') return `cancel:${plan.why}`;
  const carried = plan.reconnect ? `${plan.reconnect.edgeId}.${plan.reconnect.moving}` : '';
  return `${plan.landed}|${endKey(plan.from)}|${endKey(plan.to)}|${carried}`;
}

/**
 * Previews for one drag over one drawing: a plan the pointer resolved to on
 * the frame before is drawn as it was then, not made again. Over empty
 * canvas the open end moves a grid step at a time, and over a port or a tee
 * not at all, so most frames of a drag cost a lookup.
 */
export function previewer(scene: DropScene): (plan: DropPlan, pull: { from: Pt; to: Pt }) => PreviewShape {
  let last: { key: string; shape: PreviewShape } | null = null;
  return (plan, pull) => {
    const key = planKey(plan);
    if (last?.key !== key) last = { key, shape: previewOf(plan, scene, pull) };
    // A drop that makes nothing is drawn to the pointer, wherever it is now.
    return last.shape.cancel ? cancelled(pull) : last.shape;
  };
}

/**
 * The pull, before anything has been resolved: an L from where it started to
 * the pointer. Across the line it was pulled from, which is the way a branch
 * leaves a run; otherwise along whichever way the pointer has gone further.
 * Drawn only for as long as there is no plan to draw -- where no designer is
 * there to resolve one.
 */
export function pullOf(from: Pt, to: Pt, runDir?: Pt): Pt[] {
  const verticalFirst = runDir
    ? Math.abs(runDir.x) >= Math.abs(runDir.y)
    : Math.abs(to.y - from.y) > Math.abs(to.x - from.x);
  const corner = verticalFirst ? { x: from.x, y: to.y } : { x: to.x, y: from.y };
  return [from, corner, to];
}
