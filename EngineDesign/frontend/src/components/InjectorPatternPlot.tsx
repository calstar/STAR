import { useMemo, useState } from 'react';
import type { InjectorLayout } from '../api/client';
import { drawingModel, OX, FU } from '../lib/injectorDrawing';
import { primitivesToDxf, downloadText } from '../lib/drawingPrimitives';
import type { InjectorDrawings, Primitive } from '../lib/drawingPrimitives';
import { InjectorDrawing } from './InjectorDrawing';
import { useViewState } from '../lib/viewState';
import { cdBasis } from '../lib/injectorHardware';

/**
 * Engineering views of the injector plug in its sleeve: face, back face, and a true-scale half
 * section. All geometry comes from engine/core/injectors/layout.py and drawing.py; this file lays
 * the views out and prints the readouts.
 *
 *  FACE      what the chamber sees: the groove (on a contoured face), the round exits on its
 *            flanks, where the jets meet, the liner end outside the bore.
 *  BACK      the manifold side: the channels the passages break into, and the land between them.
 *  SECTION   the plug in the sleeve, cut through a doublet (or between two): the groove, each
 *            passage from its square exit to its channel floor, the jets, the liner and sleeve --
 *            one scale for both axes, so the angles are the angles.
 */

interface Props {
  /** From /api/geometry/injector -- engine/core/injectors/layout.py does all the geometry. */
  layout: InjectorLayout & { drawings?: InjectorDrawings };
}

const MM = 1000;
const WALL = 'var(--color-text-secondary)';
const WARN = '#fbbf24';
const BAD = '#f87171';

const fmt = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');

type Cut = 'doublet' | 'between';

/** The half right of the axis (plus the axis itself), unless both halves are wanted. */
function oneHalf(prims: Primitive[], both: boolean): Primitive[] {
  if (both) return prims;
  return prims.filter((p) => {
    if (p.t === 'poly') return p.pts.some(([x]) => x > 1e-9) || p.pts.every(([x]) => Math.abs(x) < 1e-9);
    if (p.t === 'circle') return p.c[0] > 0;
    return true;
  });
}

function Panel({ title, sub, onDxf, children }: {
  title: string; sub?: string; onDxf?: () => void; children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3">
      <div className="flex items-baseline justify-between mb-1 gap-2">
        <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">{title}</h4>
        <div className="flex items-baseline gap-2">
          {sub && <span className="text-[11px] text-[var(--color-text-secondary)]">{sub}</span>}
          {onDxf && (
            <button type="button" onClick={onDxf}
                    className="text-[11px] px-2 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
              DXF
            </button>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

export function InjectorPatternPlot({ layout }: Props) {
  const { g, drill, warnings } = useMemo(() => drawingModel(layout), [layout]);
  const [hover, setHover] = useState<string | null>(null);
  const [cut, setCut] = useViewState<Cut>('injector.sectionCut', 'doublet');
  const [unit, setUnit] = useViewState<'mm' | 'in'>('injector.dxfUnit', 'mm');
  const [mirror, setMirror] = useViewState<boolean>('injector.sectionMirror', false);
  const igniter = layout.igniter;
  const D = layout.drawings;
  const codes = new Set(warnings.filter((w) => w.level === 'bad').map((w) => w.code));
  const bad = codes.has('centre_clear') ? ['KEEPOUT'] : [];
  const exportDxf = (prims: Primitive[], name: string) =>
    downloadText(primitivesToDxf(prims, unit), `injector_${name}_${unit}.dxf`);
  const hoverText = hover
    ? `${hover.startsWith('O') ? 'LOX' : 'fuel'} element ${Number(hover.slice(1)) + 1} of ${g.n}`
    : 'hover a hole to find it in every view';

  return (
    <div className="space-y-3">
      {D && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--color-text-secondary)]">
            <span>{hoverText}</span>
            <label className="flex items-center gap-1">
              DXF units
              <select value={unit} onChange={(e) => setUnit(e.target.value as 'mm' | 'in')}
                      className="bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded px-1 py-0.5">
                <option value="mm">mm</option>
                <option value="in">in</option>
              </select>
            </label>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <Panel title="Face" sub="from the chamber" onDxf={() => exportDxf(D.face, 'face')}>
              <InjectorDrawing prims={D.face} badLayers={bad} hover={hover} onHover={setHover} maxHeight={340} />
            </Panel>
            <Panel title="Back face" sub="from the manifold side, mirrored" onDxf={() => exportDxf(D.back, 'back')}>
              <InjectorDrawing prims={D.back} hover={hover} onHover={setHover} maxHeight={340} />
            </Panel>
          </div>
          <Panel
            title="Half section"
            sub={cut === 'doublet' ? 'cut through a doublet' : 'cut between doublets'}
            onDxf={() => exportDxf(cut === 'doublet' ? D.section_doublet : D.section_between, `section_${cut}`)}
          >
            <div className="flex gap-1 mb-1">
              {(['doublet', 'between'] as Cut[]).map((c) => (
                <button key={c} type="button" onClick={() => setCut(c)}
                        className={`text-[11px] px-2 py-0.5 rounded border border-[var(--color-border)] ${cut === c ? 'bg-rose-600/20 text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]'}`}>
                  {c === 'doublet' ? 'through a doublet' : 'between doublets'}
                </button>
              ))}
              <label className="flex items-center gap-1 text-[11px] text-[var(--color-text-secondary)] ml-2">
                <input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} />
                both halves
              </label>
              <span className="ml-auto text-[11px] text-[var(--color-text-secondary)]">1:1 · manifold above, chamber below</span>
            </div>
            <InjectorDrawing prims={oneHalf(cut === 'doublet' ? D.section_doublet : D.section_between, mirror)}
                             sectioned hover={hover} onHover={setHover} maxHeight={560} textScale={mirror ? 0.55 : 1} />
            {mirror && g.n % 2 === 1 && cut === 'doublet' && (
              <div className="text-[11px] text-[var(--color-text-secondary)]">
                {g.n} doublets is odd, so the left half of this cut falls between two of them.
              </div>
            )}
          </Panel>
        </>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-[11px] leading-5 text-[var(--color-text-secondary)] font-mono">
        <div>
          <div className="text-[var(--color-text-primary)]">face — {g.contoured ? 'contoured' : 'flat'}</div>
          <div><span style={{ color: OX }}>●</span> LOX {g.n}× ⌀{fmt(layout.inputs.oxidizer.d_jet * MM, 3)} on ⌀{fmt(g.dPitchO * MM)} at {fmt(layout.inputs.oxidizer.impingement_angle, 0)}° — web {fmt(g.webO * MM)} mm</div>
          <div><span style={{ color: FU }}>●</span> fuel {g.n}× ⌀{fmt(layout.inputs.fuel.d_jet * MM, 3)} on ⌀{fmt(g.dPitchF * MM)} at {fmt(layout.inputs.fuel.impingement_angle, 0)}° — web {fmt(g.webF * MM)} mm</div>
          {g.groove && (
            <div>
              groove ⌀{fmt(2 * g.groove.groove_edge_in * MM)}–{fmt(2 * g.groove.groove_edge_out * MM)}, {fmt(g.groove.groove_depth * MM)} deep
              {' '}({g.groove.groove_is_v ? 'V' : 'flat bottom'}, flanks {fmt(g.groove.flank_included, 0)}°); exits {fmt(g.groove.exit_depth * MM)} below the face
            </div>
          )}
          {!g.degenerate && (
            <>
              <div>jets meet on ⌀{fmt(2 * g.rImp * MM)}, {fmt(g.zImp * MM)} mm in front of the face — {fmt(g.coreFrac * 100, 0)}% of the bore area</div>
              {drill.map((d) => (
                <div key={`j${d.tag}`}>
                  <span style={{ color: d.c }}>●</span> {d.tag} free jet {fmt(d.freeJet * MM)} mm = {fmt(d.freeJetLd, 1)} d (along the jet)
                </div>
              ))}
              <div className="opacity-80">included {fmt(g.included, 0)}° · axial standoff {fmt(g.lImp * MM)} mm = {fmt(g.lOverD, 2)} d̄ (Layer 1's measure)</div>
            </>
          )}
          <div>centre clear ⌀{fmt(g.centreClear * MM)} · land to the bore {fmt(g.wallLand * MM)} mm</div>
          {layout.centre_keepout.dia > 0 && (
            <div>centre keep-out ⌀{fmt(layout.centre_keepout.dia * MM)} ({layout.centre_keepout.source})</div>
          )}
          {igniter && (
            <div>
              igniter {igniter.thread}: ⌀{fmt(igniter.thread_od * MM)} thread, needs {fmt(igniter.l2 * MM)} mm engaged
              {' '}— {fmt(igniter.engaged_thickness * MM)} mm {igniter.hub_thickness ? 'at the centre' : 'plate'}
            </div>
          )}
        </div>
        <div>
          <div className="text-[var(--color-text-primary)]">
            plug ⌀{fmt(2 * layout.envelope.r_sleeve_id * MM)} × {fmt(layout.inputs.plate_thickness * MM)} mm — {layout.back.mode === 'channels' ? 'channels on the back' : 'plenum behind'}
          </div>
          {drill.map((d) => (
            <div key={d.tag}>
              <span style={{ color: d.c }}>●</span> {d.tag} passage {fmt(d.thru * MM)} mm at ⌀{fmt(d.d * MM, 3)}
              {d.boreLen > 0 && <> ({fmt(d.land * MM)} land + ⌀{fmt(d.bore * MM, 2)} counterbore)</>}
              {' '}— L/d {fmt(d.landLd, 1)}{d.offSquare > 0 ? `, drill enters ${fmt(d.offSquare, 0)}° off square` : ', square exit'}
            </div>
          ))}
          {drill.map((d) => d.channel && (
            <div key={`c${d.tag}`}>
              <span style={{ color: d.c }}>●</span> {d.tag} channel on ⌀{fmt(2 * d.channel.r_center * MM)}: {fmt(d.channel.width * MM)} wide × {fmt(d.channel.depth * MM)} deep, {d.channel.floor} floor
              {' '}(holes break through {d.channel.breakthrough})
            </div>
          ))}
          {layout.back.lands && (
            <div>
              back-face lands: centre {fmt(layout.back.lands.inner * MM)} · between channels {fmt(layout.back.lands.between * MM)} · rim {fmt(layout.back.lands.outer * MM)} mm
            </div>
          )}
          {layout.back.mode === 'plenum' && drill.map((d) => (
            <div key={`b${d.tag}`}>
              <span style={{ color: d.c }}>●</span> {d.tag} opens on the back at ⌀{fmt(2 * d.rBack * MM)} — web {fmt(d.backWeb * MM)} mm
            </div>
          ))}
          {(['O', 'F'] as const).map((k) => (
            <div key={`cd${k}`} className="opacity-80">
              {k === 'O' ? 'LOX' : 'fuel'} {cdBasis(layout.passages[k].cd)}
            </div>
          ))}
          <div className="opacity-80">
            sleeve ⌀{fmt(2 * layout.envelope.r_sleeve_id * MM)} / ⌀{fmt(2 * layout.envelope.r_sleeve_od * MM)}, liner {fmt(layout.envelope.liner_thickness * MM)} mm
            {layout.envelope.sleeve_declared ? '' : ' (sleeve not declared: taken as bore + liner)'}
          </div>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="text-[11px] leading-5 font-mono space-y-0.5">
          {warnings.map((w, i) => (
            <div key={i} style={{ color: w.level === 'bad' ? BAD : w.level === 'warn' ? WARN : WALL }}>
              {w.level === 'info' ? 'note' : w.level === 'bad' ? 'fails' : 'check'}: {w.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default InjectorPatternPlot;
