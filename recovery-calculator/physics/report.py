"""Human-readable output. PLAN.md §9 eqs (38)/(39), §8.7, §11.5.

Text only -- no matplotlib import here, so the CLI stays fast and headless.
"""

from physics.constants import G0, N_TO_LBF, M_TO_FT
from physics.loads import equivalent_height, impact_energy

RULE = "=" * 78
THIN = "-" * 78


def _fmt(value, spec="%.1f", dash="--"):
    return dash if value is None else spec % value


def device_table(per_device):
    """§8.7: report the expected load, not only the design load."""
    lines = [
        "  %-8s %7s %7s %7s %8s %9s %8s %6s %8s"
        % ("device", "v_s", "q_s", "t_f", "A", "F_inf", "F_pflnz", "1/X1", "snatch"),
        "  %-8s %7s %7s %7s %8s %9s %8s %6s %8s"
        % ("", "m/s", "Pa", "s", "", "N", "N", "", "N"),
    ]
    for dl in per_device:
        if not dl.fired:
            lines.append("  %-8s  did not open" % dl.name)
            continue
        lines.append(
            "  %-8s %7.2f %7.1f %7.3f %8.4f %9.1f %8.1f %6.2f %8s"
            % (dl.name, dl.v_s, dl.q_s, dl.t_f, dl.A, dl.F_inf, dl.F_pflanz,
               dl.ratio, _fmt(dl.F_snatch, "%.1f"))
        )
        if not dl.bound_valid:
            lines.append(
                "           !! v_s = %.2f m/s is below the sqrt(g*s_f) floor "
                "of %.2f m/s." % (dl.v_s, dl.v_floor))
            lines.append(
                "              The eq (23) bound is NOT a bound here -- it "
                "errs low.")
    return lines


def case_summary(results):
    """§11.5: each case fails in a different category, so report each against
    its own metric rather than emitting a bare PASS/FAIL."""
    lines = [
        "  %-14s %9s %9s %9s %11s %11s"
        % ("case", "descent", "impact", "KE", "max F_inf", "fails on"),
        "  %-14s %9s %9s %9s %11s %11s"
        % ("", "s", "m/s", "J", "N", ""),
    ]
    categories = {
        "nominal": "--",
        "simultaneous": "drift",
        "no_main": "impact",
        "no_drogue": "structure",
    }
    for name, cr in results.items():
        run = cr.run
        fired = [d for d in cr.per_device if d.fired]
        F_inf = max((d.F_inf for d in fired), default=0.0)
        lines.append(
            "  %-14s %9.1f %9.2f %9.0f %11.0f %11s"
            % (name, run.t_ground, run.v_impact,
               impact_energy(run.m, run.v_impact), F_inf,
               categories.get(name, "--"))
        )
    return lines


def _corner_str(corner, irrelevant=(), attitude=None):
    """Render a corner, marking parameters that had no bearing on the result.

    Without the marking, `max()` ties get reported as though they mattered:
    F_design is identical at v_rel = 5 and 20 whenever the infinite-mass bound
    governs, so naming one of them invites the reader to conclude that value
    is the dangerous one.

    `CdS_body` is shown by its §6.4 attitude name with the area in brackets.
    It travels as a number because a custom bound has no name, but "0.00507"
    on its own tells a reader nothing about which way the vehicle is pointing.
    """
    parts = []
    for key, value in corner.items():
        if key == "CdS_body":
            shown = "%s (%.5f m2)" % (attitude or "airframe", value)
        elif isinstance(value, float):
            shown = "%g" % value
        else:
            shown = str(value)
        parts.append("%s=%s%s"
                     % (key, shown, " (no effect)" if key in irrelevant else ""))
    return "  ".join(parts)


def render_sweep(rows):
    """§11.9 corner sweep, reported per failure category.

    One "worst corner" is not enough, for exactly the reason §11.5 gives about
    cases: the categories are decided by different metrics, so they have
    different worst corners. For the worked vehicle the structural worst case
    is the *axial* airframe bound and the drift worst case is *broadside* --
    literally the opposite corner. A single headline would state the airframe
    is nose-down while the descent-time risk sits at the other bound.
    """
    from physics.cases import governing_candidates, worst_by_category

    out = [THIN, "CORNER SWEEP -- %d runs" % len(rows), ""]
    out.append("  Each category has its OWN worst corner. They differ.")
    out.append("")

    by_cat = worst_by_category(rows)
    for name in ("structure", "drift", "impact"):
        entry = by_cat[name]
        out.append("  %-10s %s %.0f %s" % (name.upper(), entry["metric"],
                                           entry["value"], entry["unit"]))
        cr = entry["result"]
        out.append("             %s" % _corner_str(entry["corner"],
                                                   entry["irrelevant"],
                                                   cr.which))
        if name == "structure":
            out.append("             governed by %s / %s"
                       % (cr.design.governing_device,
                          cr.design.governing_candidate))
        out.append("")

    designs = [cr.design.F_design or 0.0 for _, cr in rows]
    lo, hi = min(designs), max(designs)
    out.append("  F_design across all corners: %.0f - %.0f N (%.1fx)"
               % (lo, hi, (hi / lo) if lo else float("inf")))

    counts = governing_candidates(rows)
    out.append("  eq (36) governed by:")
    for key, n in counts.items():
        out.append("    %-34s %2d of %d corners" % (key, n, len(rows)))
    if len(counts) > 1:
        out.append("  The governing candidate CHANGES across the sweep, so "
                   "which fix helps")
        out.append("  depends on which corner you believe.")
    out.append(THIN)
    return "\n".join(out)


def render(config, results, which="axial"):
    """Full text report for one airframe bound."""
    nominal = results["nominal"]
    run = nominal.run
    out = [RULE, "RECOVERY CALCULATOR -- airframe %s bound" % which.upper(), RULE, ""]

    out.append("VEHICLE")
    out.append("  mass %.3f kg (body %.3f kg)   apogee %.0f m AGL   site %.0f m MSL"
               % (run.m, run.m_b, config.vehicle.h_a, config.site.z_site))
    out.append("  CdS_body %.5f m2   T_pad %.2f K   p_pad %.0f Pa   L0 %.6f K/m"
               % (run.CdS_body, run.atm.T_pad, run.atm.p_pad, run.atm.L0))
    out.append("")

    out.append("NOMINAL DESCENT")
    out.append("  descent time   %8.1f s" % run.t_ground)
    out.append("  impact speed   %8.2f m/s (%.1f fps)"
               % (run.v_impact, run.v_impact * M_TO_FT))
    out.append("  impact energy  %8.0f J   = a %.1f m fall (eq 39)"
               % (impact_energy(run.m, run.v_impact),
                  equivalent_height(run.v_impact)))
    out.append("")

    out.append("PER-DEVICE LOADS  (the bound, the expected value, and 1/X1,")
    out.append("                   the conservatism you are carrying)")
    out.extend(device_table(nominal.per_device))
    out.append("")

    d = nominal.design
    if d.F_design is not None:
        out.append("DESIGN LOAD, eq (36)")
        out.append("  F_design = %.1f x %.0f N = %.0f N (%.0f lbf)"
                   % (d.safety_factor, d.governing_value, d.F_design,
                      d.F_design * N_TO_LBF))
        out.append("  governed by: %s / %s"
                   % (d.governing_device, d.governing_candidate))
        peak = float(run.traj.F_T.max()) if len(run.traj.t) else 0.0
        Cx = max((x.Cx for x in run.devices), default=1.8)
        out.append("  numerical peak max F_T = %.1f N; x Cx = %.1f N (eq 21a)"
                   % (peak, Cx * peak))
        if d.F_allow is not None:
            out.append("  F_allow  = %.0f N (%.0f lbf), governed by %s"
                       % (d.F_allow, d.F_allow * N_TO_LBF, d.governing_link))
            out.append("  VERDICT  : %s" % ("PASS" if d.passes else "FAIL"))
        out.append("")

    out.append("OFF-NOMINAL CASES  (computed on every run, because a report")
    out.append("                    showing only the nominal case hides a")
    out.append("                    single-point failure)")
    out.extend(case_summary(results))
    out.append("")

    warns = list(config.warnings())
    for name, cr in results.items():
        for w in cr.run.warnings:
            warns.append("%s: %s" % (name, w))
    no_drogue = results.get("no_drogue")
    if no_drogue is not None and d.F_design is not None:
        nd = no_drogue.design
        if nd.F_design and nd.F_design > d.F_design:
            warns.insert(0, "Drogue failure reaches %.0f N - %.1fx the "
                            "nominal design load. The main opens out of "
                            "free fall."
                            % (nd.F_design, nd.F_design / d.F_design))
    if warns:
        out.append("WARNINGS")
        for w in warns:
            out.append("  * %s" % w)
        out.append("")

    out.append(THIN)
    return "\n".join(out)


def render_crosscheck(comparison):
    """The §2 cross-check: our model, OpenRocket and the mastersheet.

    Deliberately renders a missing value as `not computed` with a footnote
    rather than as a dash in a numeric column. OpenRocket has no opening-load
    calculation at all and the mastersheet has no acceleration; a reader
    skimming a column of numbers must not take either absence for a small
    number.
    """
    c = comparison
    out = [RULE, "CROSS-CHECK -- our model vs OpenRocket vs the mastersheet",
           RULE, ""]
    out.append("  Comparison only. Nothing here sizes hardware: no off-nominal")
    out.append("  cases, no corner sweep, no safety factor. Our column is the")
    out.append("  nominal case at the %s airframe bound." % c.which.upper())
    out.append("")

    out.append("  %-26s %12s %12s %12s %8s"
               % ("", "ours", "OpenRocket", "mastersheet", "spread"))
    out.append("  " + THIN[:74])

    notes = []
    for m in c.metrics:
        cells = []
        for model in ("ours", "openrocket", "mastersheet"):
            v = m.values.get(model)
            cells.append("%12s" % "--" if v is None else "%12.3f" % v)
        spread = "%7.2fx" % m.spread if m.spread else "%7s" % "--"
        marker = ""
        if m.note:
            notes.append((len(notes) + 1, m.label, m.note))
            marker = " [%d]" % len(notes)
        out.append("  %-26s %s %s %s %s%s"
                   % (m.label, cells[0], cells[1], cells[2], spread, marker))

    out.append("")
    if notes:
        for n, label, note in notes:
            out.append("  [%d] %s: %s" % (n, label, note))
        out.append("")

    if c.warnings:
        out.append("WARNINGS")
        for w in c.warnings:
            out.append("  * %s" % w)
        out.append("")

    out.append(THIN)
    return "\n".join(out)
