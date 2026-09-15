import { useMemo } from 'react';

/**
 * Two engineering views of an unlike-doublet injector, drawn from the design variables.
 *
 * Nothing here is stored directly -- it is all derived, and the derivation IS the doublet:
 *
 *   D_pitch = n * spacing / pi          each stream sits on its own pitch circle
 *   dr      = |D_pitch_O - D_pitch_F| / 2
 *   L_imp   = dr / (tan th_O + tan th_F)   the jets close that radial gap and collide
 *   r_imp   = r_inner + L_imp * tan(th_inner)
 *
 * TWO THINGS THIS DRAWING EXISTS TO MAKE VISIBLE, because the numbers hid them:
 *
 *  1. WHERE THE SPRAY ACTUALLY GOES. Every doublet collides on the SAME circle, r_imp. On
 *     the first design that survived every gate, that circle was 41.79 mm across inside a
 *     127.00 mm bore -- narrower than the 49.57 mm throat, feeding 10.8 % of the chamber
 *     area. No constraint saw it. The face view draws the impingement circle against the
 *     bore so the mass distribution is a picture, not an inference.
 *
 *  2. THE HOLES ARE NOT ROUND ON THE FACE. A drill of diameter d inclined th from the
 *     chamber axis cuts an axis-normal face as an ELLIPSE: minor axis d circumferentially,
 *     major axis d/cos(th) radially. At 69 deg that is 2.79x the drill diameter, and it is
 *     the radial number that decides whether a centre boss or the chamber wall is clear.
 *     Drawing round holes understates the footprint of every steep orifice.
 */

export interface InjectorStream {
  n_elements: number;
  d_jet: number;              // m
  impingement_angle: number;  // deg from the chamber axis
  spacing: number;            // m, circumferential centre-to-centre on its own pitch circle
}

interface Props {
  oxidizer: InjectorStream;
  fuel: InjectorStream;
  boreDiameter: number;             // m
  /** Fuel ring outboard of the LOX ring. Sets which way a momentum imbalance tilts the fan. */
  fuelOutboard?: boolean;
  /** Reserved clear circle at the axis (igniter boss / centre port) [m]. */
  centerClearDiameter?: number;
  /** Minimum land between adjacent holes on a ring [m]. */
  minWeb?: number;
  /** Minimum radial land from the outer ring's face trace to the bore [m]. */
  wallClearance?: number;
  /** Standoff acceptance band in orifice diameters. */
  ldMin?: number;
  ldMax?: number;
  /** Face plate thickness, for the drilled-depth callout [m]. */
  plateThickness?: number;
  /**
   * Feed-passage (counterbore) diameter behind each orifice [m].
   *
   * An orifice is NOT a small hole through the whole plate. It is a short LAND at the face
   * end of a much larger feed passage -- the land sets Cd (that is `discharge.orifice_l_over_d`)
   * and the passage carries the flow. Reporting the drilled depth against the orifice
   * diameter claimed L/d 13.5 on a design whose small drill only goes 6.6 mm. 0 falls back
   * to the orifice diameter, which is the conservative reading.
   */
  counterboreDiameter?: number;
  /** Orifice land length in orifice diameters -- discharge.orifice_l_over_d. */
  orificeLandLOverD?: number;
}

const MM = 1000;
const OX = '#38bdf8';     // oxidiser: cold
const FU = '#fb923c';     // fuel: warm
const WALL = 'var(--color-text-secondary)';
const INK = 'var(--color-text-primary)';
const WARN = '#fbbf24';
const BAD = '#f87171';

const fmt = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Radial half-extent of an inclined orifice's elliptical trace on the face. */
const halfMajor = (d: number, thetaDeg: number) =>
  (0.5 * d) / Math.max(0.1, Math.abs(Math.cos(rad(thetaDeg))));

export interface InjectorLayoutInput {
  oxidizer: InjectorStream;
  fuel: InjectorStream;
  boreDiameter: number;
  fuelOutboard?: boolean;
  centerClearDiameter?: number;
  minWeb?: number;
  wallClearance?: number;
  ldMin?: number;
  ldMax?: number;
  plateThickness?: number;
  counterboreDiameter?: number;
  orificeLandLOverD?: number;
}

export interface InjectorWarning {
  level: 'warn' | 'bad';
  text: string;
}

/**
 * Everything the drawing asserts about the hardware, with no DOM in it.
 *
 * Kept separate from the SVG so it can be tested in plain node: the geometry is the part
 * that carries engineering consequences, the SVG is presentation.
 */
export function deriveInjectorLayout({
  oxidizer, fuel, boreDiameter, fuelOutboard = true,
  centerClearDiameter = 0, minWeb = 0, wallClearance = 0,
  ldMin = 5, ldMax = 7, plateThickness = 0.0127,
  counterboreDiameter = 0, orificeLandLOverD = 4,
}: InjectorLayoutInput) {
  const n = Math.max(1, Math.round(oxidizer.n_elements));
  const dPitchO = (n * oxidizer.spacing) / Math.PI;
  const dPitchF = (Math.max(1, Math.round(fuel.n_elements)) * fuel.spacing) / Math.PI;
  const dr = Math.abs(dPitchO - dPitchF) / 2;
  const tanSum = Math.tan(rad(oxidizer.impingement_angle)) + Math.tan(rad(fuel.impingement_angle));
  const lImp = tanSum > 1e-9 ? dr / tanSum : 0;
  const dAvg = 0.5 * (oxidizer.d_jet + fuel.d_jet);

  // Which ring is inboard is a fact about the pitch circles, not a declaration -- but when
  // they coincide (dr = 0, a degenerate non-injector) fall back to the caller's intent.
  const oxIsInner = dPitchO === dPitchF ? fuelOutboard : dPitchO < dPitchF;
  const inner = oxIsInner ? oxidizer : fuel;
  const outer = oxIsInner ? fuel : oxidizer;
  const rInner = (oxIsInner ? dPitchO : dPitchF) / 2;
  const rOuter = (oxIsInner ? dPitchF : dPitchO) / 2;
  const rImp = rInner + lImp * Math.tan(rad(inner.impingement_angle));
  const rBore = boreDiameter / 2;

  // Face real estate, measured on the ELLIPTICAL traces.
  const innerEdge = rInner - halfMajor(inner.d_jet, inner.impingement_angle);
  const outerEdge = rOuter + halfMajor(outer.d_jet, outer.impingement_angle);

  const g = {
    n, rBore, rO: dPitchO / 2, rF: dPitchF / 2, dPitchO, dPitchF, dr, lImp,
    lOverD: dAvg > 0 ? lImp / dAvg : 0,
    included: oxidizer.impingement_angle + fuel.impingement_angle,
    webO: oxidizer.spacing - oxidizer.d_jet,
    webF: fuel.spacing - fuel.d_jet,
    oxIsInner, inner, outer, rInner, rOuter, rImp,
    centreClear: 2 * innerEdge,
    wallLand: rBore - outerEdge,
    // Fraction of the chamber cross-section inside the impingement circle.
    coreFrac: rBore > 0 ? (rImp / rBore) ** 2 : 0,
    overflow: outerEdge > rBore,
    degenerate: !(lImp > 1e-6),
  };

  // Drilling: a hole at th from the axis meets the face at (90 - th); shallow entry walks a drill.
  const drill = [
    { tag: 'LOX', d: oxidizer.d_jet, th: oxidizer.impingement_angle, c: OX },
    { tag: 'fuel', d: fuel.d_jet, th: fuel.impingement_angle, c: FU },
  ].map((st) => {
    // Total passage through the plate, along the hole axis.
    const thru = plateThickness / Math.cos(rad(st.th));
    // The small drill only cuts the LAND; the rest is opened out to the counterbore.
    const land = Math.min(thru, orificeLandLOverD * st.d);
    const bore = counterboreDiameter > st.d ? counterboreDiameter : st.d;
    const boreLen = Math.max(0, thru - land);
    return {
      ...st, thru, land, bore, boreLen,
      landLd: land / st.d,                    // sets Cd
      boreLd: bore > 0 ? boreLen / bore : 0,  // what the roughing drill sees
      incidence: 90 - st.th,
    };
  });

  const warnings: InjectorWarning[] = [];
  if (g.overflow) {
    warnings.push({ level: 'bad', text: 'outer ring falls outside the chamber wall — orifices would be drilled into the liner' });
  }
  if (g.degenerate) {
    warnings.push({ level: 'bad', text: 'the two rings are on the same pitch circle — dr = 0, so the jets meet AT the face plate. That is a face-eroding non-injector, not a doublet.' });
  }
  if (centerClearDiameter > 0 && g.centreClear < centerClearDiameter) {
    warnings.push({ level: 'bad', text: `centre clear ⌀${fmt(g.centreClear * MM)} < ⌀${fmt(centerClearDiameter * MM)} reserved` });
  }
  if (wallClearance > 0 && g.wallLand < wallClearance) {
    warnings.push({ level: 'bad', text: `wall land ${fmt(g.wallLand * MM)} mm < ${fmt(wallClearance * MM)} mm required` });
  }
  if (minWeb > 0 && Math.min(g.webO, g.webF) < minWeb) {
    warnings.push({ level: 'bad', text: `web ${fmt(Math.min(g.webO, g.webF) * MM)} mm < ${fmt(minWeb * MM)} mm required` });
  }
  if (g.included > 90) {
    warnings.push({ level: 'warn', text: `included ${fmt(g.included, 0)}° > 90° — NASA SP-8089 face-heating threshold; copper face` });
  }
  if (!g.degenerate && (g.lOverD < ldMin || g.lOverD > ldMax)) {
    warnings.push({ level: 'warn', text: `standoff L/d ${fmt(g.lOverD, 2)} outside the ${ldMin}–${ldMax} band` });
  }
  if (!g.degenerate && g.coreFrac < 0.25) {
    warnings.push({ level: 'warn', text: `all ${g.n} elements collide on a ⌀${fmt(2 * g.rImp * MM)} circle — only ${fmt(g.coreFrac * 100, 0)}% of the chamber area is fed directly` });
  }
  // Two separate drills, two separate limits. The orifice land is short by construction;
  // the roughing pass down to it is the one that can get deep.
  const deepestLand = drill.reduce((a, b) => (a.landLd >= b.landLd ? a : b));
  if (deepestLand.landLd > 10) {
    warnings.push({ level: 'warn', text: `${deepestLand.tag} orifice land is ${fmt(deepestLand.land * MM, 1)} mm at ⌀${fmt(deepestLand.d * MM, 3)} — L/d ${fmt(deepestLand.landLd, 1)}, past twist-drill practice` });
  }
  const deepestBore = drill.reduce((a, b) => (a.boreLd >= b.boreLd ? a : b));
  if (deepestBore.boreLd > 10) {
    warnings.push({ level: 'warn', text: `${deepestBore.tag} feed passage is ${fmt(deepestBore.boreLen * MM, 1)} mm at ⌀${fmt(deepestBore.bore * MM, 2)} — L/d ${fmt(deepestBore.boreLd, 1)}; open the counterbore or use a gundrill` });
  }
  const shallowest = drill.reduce((a, b) => (a.incidence <= b.incidence ? a : b));
  if (shallowest.incidence < 40) {
    warnings.push({ level: 'warn', text: `${shallowest.tag} meets the face at ${fmt(shallowest.incidence, 0)}° — needs a spotface normal to the hole axis or the drill walks` });
  }

  return { g, drill, warnings };
}

export function InjectorPatternPlot({
  oxidizer, fuel, boreDiameter, fuelOutboard = true,
  centerClearDiameter = 0, minWeb = 0, wallClearance = 0,
  ldMin = 5, ldMax = 7, plateThickness = 0.0127,
}: Props) {
  const { g, drill, warnings } = useMemo(
    () => deriveInjectorLayout({
      oxidizer, fuel, boreDiameter, fuelOutboard,
      centerClearDiameter, minWeb, wallClearance, ldMin, ldMax, plateThickness,
    }),
    [oxidizer, fuel, boreDiameter, fuelOutboard, centerClearDiameter, minWeb,
     wallClearance, ldMin, ldMax, plateThickness],
  );
  const degenerate = g.degenerate;

  // ---- FACE VIEW -------------------------------------------------------------------
  const FACE = 280;
  const C = FACE / 2;
  const fs = (C - 30) / g.rBore;
  const px = (r: number, a: number) => C + r * fs * Math.cos(a);
  const py = (r: number, a: number) => C + r * fs * Math.sin(a);

  const pairs = Array.from({ length: g.n }, (_, i) => {
    const a = (2 * Math.PI * i) / g.n - Math.PI / 2;
    return { a, deg: (a * 180) / Math.PI };
  });

  /** Orifice as its true elliptical trace: major axis radial, minor circumferential. */
  const hole = (r: number, a: number, d: number, th: number, fill: string, key: string) => (
    <ellipse
      key={key}
      cx={px(r, a)} cy={py(r, a)}
      rx={Math.max(0.9, halfMajor(d, th) * fs)}
      ry={Math.max(0.7, (d / 2) * fs)}
      transform={`rotate(${(a * 180) / Math.PI} ${px(r, a)} ${py(r, a)})`}
      fill={fill}
    />
  );

  // ---- SIDE SECTION ----------------------------------------------------------------
  // The standoff is millimetres against a bore of tens of millimetres, so one scale makes
  // the jets invisible. Independent x/y scales, labelled -- normal practice when the
  // feature of interest is far smaller than the part.
  const SW = 320, SH = 250;
  const axisY = SH / 2;
  const xSpan = Math.max(g.lImp * 2.6, 1e-4);
  const ySpan = Math.max(g.rOuter * 1.22, 1e-4);
  const sxS = (SW - 74) / xSpan;
  const syS = (SH / 2 - 28) / ySpan;
  const sx = (x: number) => 58 + x * sxS;
  const sy = (r: number) => axisY - r * syS;
  const meetX = sx(g.lImp);

  const innerCol = g.oxIsInner ? OX : FU;
  const outerCol = g.oxIsInner ? FU : OX;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* ================= FACE VIEW ================= */}
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3">
        <div className="flex items-baseline justify-between mb-1">
          <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">Injector face</h4>
          <span className="text-[11px] text-[var(--color-text-secondary)]">viewed from the chamber</span>
        </div>
        <svg viewBox={`0 0 ${FACE} ${FACE}`} className="w-full" style={{ maxHeight: 320 }}>
          {/* bore */}
          <circle cx={C} cy={C} r={g.rBore * fs} fill="none" stroke={WALL} strokeWidth={1.5} />
          {/* wall clearance envelope */}
          {wallClearance > 0 && (
            <circle cx={C} cy={C} r={(g.rBore - wallClearance) * fs} fill="none"
                    stroke={WALL} strokeWidth={0.6} strokeDasharray="2 4" opacity={0.5} />
          )}
          {/* impingement circle -- where every doublet actually collides */}
          <circle cx={C} cy={C} r={g.rImp * fs} fill={INK} opacity={0.06} />
          <circle cx={C} cy={C} r={g.rImp * fs} fill="none" stroke={INK}
                  strokeWidth={0.9} strokeDasharray="5 3" opacity={0.55} />
          {/* pitch circles */}
          <circle cx={C} cy={C} r={g.rO * fs} fill="none" stroke={OX} strokeWidth={0.7} strokeDasharray="3 3" opacity={0.6} />
          <circle cx={C} cy={C} r={g.rF * fs} fill="none" stroke={FU} strokeWidth={0.7} strokeDasharray="3 3" opacity={0.6} />
          {/* reserved centre circle / igniter boss */}
          {centerClearDiameter > 0 && (
            <>
              <circle cx={C} cy={C} r={(centerClearDiameter / 2) * fs}
                      fill="none" stroke={g.centreClear < centerClearDiameter ? BAD : WALL}
                      strokeWidth={1.1} strokeDasharray="4 2" />
              <text x={C} y={C - (centerClearDiameter / 2) * fs - 3} textAnchor="middle"
                    fontSize={7} fill={g.centreClear < centerClearDiameter ? BAD : WALL}>
                ⌀{fmt(centerClearDiameter * MM)} reserved
              </text>
            </>
          )}
          {/* centre mark */}
          <line x1={C - 7} y1={C} x2={C + 7} y2={C} stroke={WALL} strokeWidth={0.6} />
          <line x1={C} y1={C - 7} x2={C} y2={C + 7} stroke={WALL} strokeWidth={0.6} />

          {pairs.map((p, i) => (
            <g key={i}>
              <line x1={px(g.rO, p.a)} y1={py(g.rO, p.a)} x2={px(g.rF, p.a)} y2={py(g.rF, p.a)}
                    stroke={WALL} strokeWidth={0.4} opacity={0.3} />
              {hole(g.rO, p.a, oxidizer.d_jet, oxidizer.impingement_angle, OX, `o${i}`)}
              {hole(g.rF, p.a, fuel.d_jet, fuel.impingement_angle, FU, `f${i}`)}
            </g>
          ))}

          <text x={C} y={13} textAnchor="middle" fontSize={8} fill={WALL}>⌀{fmt(boreDiameter * MM)} bore</text>
          {/* Above the axis: the pitch-circle callouts below it are only a few mm away in
              model space and the two labels collided on the shipped design. */}
          {!degenerate && (
            <text x={C} y={C - g.rImp * fs - 4} textAnchor="middle" fontSize={7} fill={INK} opacity={0.75}>
              ⌀{fmt(2 * g.rImp * MM)} impingement
            </text>
          )}
          <text x={C} y={C + g.rO * fs + 9} textAnchor="middle" fontSize={7.5} fill={OX}>⌀{fmt(g.dPitchO * MM)}</text>
          {Math.abs(g.rF - g.rO) * fs > 9 && (
            <text x={C} y={C + g.rF * fs + 9} textAnchor="middle" fontSize={7.5} fill={FU}>⌀{fmt(g.dPitchF * MM)}</text>
          )}
        </svg>
        <div className="mt-1 text-[11px] leading-5 text-[var(--color-text-secondary)] font-mono">
          <div><span style={{ color: OX }}>●</span> LOX {g.n}× ⌀{fmt(oxidizer.d_jet * MM, 3)} on ⌀{fmt(g.dPitchO * MM)} — web {fmt(g.webO * MM)} mm</div>
          <div><span style={{ color: FU }}>●</span> fuel {g.n}× ⌀{fmt(fuel.d_jet * MM, 3)} on ⌀{fmt(g.dPitchF * MM)} — web {fmt(g.webF * MM)} mm</div>
          <div>centre clear ⌀{fmt(g.centreClear * MM)} · wall land {fmt(g.wallLand * MM)} mm</div>
          {!degenerate && (
            <div>spray reaches ⌀{fmt(2 * g.rImp * MM)} — {fmt(g.coreFrac * 100, 0)}% of the chamber area</div>
          )}
        </div>
      </div>

      {/* ================= SIDE SECTION ================= */}
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3">
        <div className="flex items-baseline justify-between mb-1">
          <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">Section through one doublet</h4>
          <span className="text-[11px] text-[var(--color-text-secondary)]">flow left → right</span>
        </div>
        {degenerate ? (
          <div className="flex items-center justify-center text-center px-4"
               style={{ height: 200 }}>
            <span className="text-[11px] leading-5 text-[#f87171] font-mono">
              No section to draw: the rings coincide (dr = 0), so the jets never converge.
              Separate the pitch circles — that separation is the whole mechanism of a doublet.
            </span>
          </div>
        ) : (
        <svg viewBox={`0 0 ${SW} ${SH}`} className="w-full" style={{ maxHeight: 320 }}>
          {ySpan >= g.rBore && (
            <>
              <line x1={sx(0)} y1={sy(g.rBore)} x2={SW - 4} y2={sy(g.rBore)} stroke={WALL} strokeWidth={1.4} />
              <line x1={sx(0)} y1={sy(-g.rBore)} x2={SW - 4} y2={sy(-g.rBore)} stroke={WALL} strokeWidth={1.4} />
            </>
          )}
          <line x1={sx(0)} y1={axisY} x2={SW - 4} y2={axisY} stroke={WALL} strokeWidth={0.5}
                strokeDasharray="7 3 2 3" opacity={0.6} />
          {/* the face plate, drawn to thickness */}
          <rect x={sx(0) - Math.max(6, plateThickness * sxS)} y={24}
                width={Math.max(6, plateThickness * sxS)} height={SH - 48}
                fill={WALL} opacity={0.16} />
          <line x1={sx(0)} y1={24} x2={sx(0)} y2={SH - 24} stroke={WALL} strokeWidth={2} />
          <text x={sx(0) - Math.max(6, plateThickness * sxS) - 4} y={axisY} textAnchor="middle"
                fontSize={7.5} fill={WALL}
                transform={`rotate(-90 ${sx(0) - Math.max(6, plateThickness * sxS) - 4} ${axisY})`}>
            face · {fmt(plateThickness * MM, 1)} mm
          </text>

          {[1, -1].map((s) => (
            <g key={s}>
              <line x1={sx(0)} y1={sy(s * g.rInner)} x2={meetX} y2={sy(s * g.rImp)}
                    stroke={innerCol} strokeWidth={1.8} />
              <line x1={sx(0)} y1={sy(s * g.rOuter)} x2={meetX} y2={sy(s * g.rImp)}
                    stroke={outerCol} strokeWidth={1.8} />
              <circle cx={meetX} cy={sy(s * g.rImp)} r={2.7} fill={INK} />
            </g>
          ))}

          {/* standoff dimension */}
          <line x1={sx(0)} y1={17} x2={meetX} y2={17} stroke={WALL} strokeWidth={0.6} />
          <line x1={sx(0)} y1={14} x2={sx(0)} y2={20} stroke={WALL} strokeWidth={0.6} />
          <line x1={meetX} y1={14} x2={meetX} y2={20} stroke={WALL} strokeWidth={0.6} />
          <text x={(sx(0) + meetX) / 2} y={12} textAnchor="middle" fontSize={7.5} fill={WALL}>
            {fmt(g.lImp * MM)} mm (L/d {fmt(g.lOverD, 2)})
          </text>

          <text x={meetX + 7} y={sy(g.rImp) - 7} fontSize={7.5} fill={INK}>impingement</text>
          <text x={sx(0) + 5} y={sy(g.rInner) - 5} fontSize={7.5} fill={innerCol}>
            {fmt(g.inner.impingement_angle, 0)}°
          </text>
          <text x={sx(0) + 5} y={sy(g.rOuter) - 5} fontSize={7.5} fill={outerCol}>
            {fmt(g.outer.impingement_angle, 0)}°
          </text>
        </svg>
        )}
        <div className="mt-1 text-[11px] leading-5 text-[var(--color-text-secondary)] font-mono">
          <div>included {fmt(g.included, 0)}° · standoff {fmt(g.lImp * MM)} mm · L/d {fmt(g.lOverD, 2)}</div>
          <div>ring offset dr {fmt(g.dr * MM)} mm — the gap the jets close to meet</div>
          {drill.map((d) => (
            <div key={d.tag}>
              <span style={{ color: d.c }}>●</span> {d.tag} {fmt(d.thru * MM, 1)} mm through the plate
              {' '}= ⌀{fmt(d.bore * MM, 2)}×{fmt(d.boreLen * MM, 1)} + ⌀{fmt(d.d * MM, 3)}×{fmt(d.land * MM, 1)} land
              {' '}(L/d {fmt(d.landLd, 1)}), face at {fmt(d.incidence, 0)}°
            </div>
          ))}
          <div className="opacity-70">axial scale ×{fmt(sxS / syS, 1)} vs radial</div>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="lg:col-span-2 text-[11px] leading-5 font-mono space-y-0.5">
          {warnings.map((w, i) => (
            <div key={i} style={{ color: w.level === 'bad' ? BAD : WARN }}>⚠ {w.text}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export default InjectorPatternPlot;
