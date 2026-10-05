"""Layer X transient diagnostics against closed forms (engine/layerx/diag/{start,shutdown,waterhammer,outflow}.py).

Every test here checks the code against a hand calculation or a closed-form solution, never against
the code itself. The LE4 cases at the bottom need a prepared Layer X burn and are skipped unless
``LAYERX_GOLDEN=1``.
"""

from __future__ import annotations

import math
import os

import pytest
from scipy.optimize import brentq

from engine.layerx.diag import start as S

PSI = 6894.757293168361


# ------------------------------------------------------------------ start: the column


def test_column_inertance_only_is_the_linear_ramp():
    """I dm/dt = dp with no loss: m = dp t / I, exactly, at any step."""
    I, dp, dt = 1495.0, 3.9e6, 1e-4
    m = 0.0
    for _ in range(100):
        m = S.column_step(m, dp, I, 0.0, dt)
    assert m == pytest.approx(dp * 100 * dt / I, rel=1e-12)


def test_column_with_loss_is_the_tanh_solution():
    """I dm/dt = dp - R m^2 from rest: m = m_inf tanh(t/tau), m_inf = sqrt(dp/R), tau = I/sqrt(R dp)."""
    I, R, dp, dt = 10297.0, 1.4e6, 3.9e6, 1e-6
    m_inf, tau = math.sqrt(dp / R), I / math.sqrt(R * dp)
    m, t = 0.0, 0.0
    checks = {round(k * tau / 2, 9) for k in (1, 2, 4, 8)}
    seen = 0
    for n in range(1, int(4.0 * tau / dt) + 2):
        m = S.column_step(m, dp, I, R, dt)
        t = n * dt
        for tc in checks:
            if abs(t - tc) < dt / 2:
                assert m == pytest.approx(m_inf * math.tanh(t / tau), rel=2e-3)
                seen += 1
    assert seen == len(checks)


def test_column_quasi_steady_without_inertance():
    assert S.column_step(0.3, 4.0e6, 0.0, 1.0e6, 1e-3) == pytest.approx(2.0)
    assert S.column_step(0.3, -4.0e6, 0.0, 1.0e6, 1e-3) == pytest.approx(-2.0)


def test_chamber_filling_time_constant_is_lstar_over_gamma2_cstar():
    """dPc/dt = (RT/V)(m - Pc At/c*), RT = (Gamma c*)^2: a first-order lag with tau = V/(Gamma^2 c* At)."""
    V, At, cs, gam, m, pa = 2.44e-3, 1.795e-3, 1575.0, 1.135, 3.07, 94000.0
    G = S.gamma_function(gam)
    # Gamma by hand for gamma = 1.135 (the ideal-rocket mass-flow function): sqrt(1.135) * (2/2.135)^(2.135/0.27)
    assert G == pytest.approx(math.sqrt(1.135) * (2 / 2.135) ** (2.135 / 0.27), rel=1e-12)
    rt_v = (G * cs) ** 2 / V
    tau = V / (G * G * cs * At)
    pc_ss = m * cs / At
    pc, dt = pa, tau / 2000
    for _ in range(2000):            # one tau
        pc = S.chamber_step(pc, m, rt_v, At / cs, dt)
    assert pc == pytest.approx(pc_ss + (pa - pc_ss) * math.exp(-1.0), rel=2e-3)
    # LE4's chamber constant, AUDIT 9.5 §1: ~2.1 ms
    assert 1.5e-3 < tau < 2.5e-3


# ------------------------------------------------------------------ start: the whole model


def _const(v):
    return lambda mr, m: v


def _chamber(**kw):
    base = dict(volume=2.44e-3, throat_area=1.795e-3, exit_area=8.66e-3, ambient_pa=94069.7, gamma=1.135,
                cstar=_const(1570.0), vvac=_const(2320.0), mr_design=1.52)
    base.update(kw)
    return S.StartChamber(**base)


def _line(key, **kw):
    base = dict(key=key, rho=1150.0 if key == "ox" else 792.8, p_tank=578.0 * PSI, I_up=747.0, R_up=2.9e4,
                R_valve_open=2213.0, travel_s=0.05, t_open=0.0, I_dn=747.0, V_dn_line=6.6e-6, R_dn=1.0e4,
                V_manifold=1.8e-5, A_exit=9.37e-5, I_inj=163.0, phi=1.73e-3)
    base.update(kw)
    return S.StartLine(**base)


def test_no_gas_volume_means_no_priming_delay():
    ox = _line("ox", V_dn_line=0.0, V_manifold=0.0)
    fu = _line("fuel", V_dn_line=0.0, V_manifold=0.0, t_open=-0.02)
    run = S.run_start(ox, fu, _chamber(), dt=2e-5, horizon_s=0.05)
    assert run["t_prime"][0] == pytest.approx(0.0, abs=1e-12)
    assert run["t_prime"][1] == pytest.approx(-0.02, abs=1e-12)
    assert run["t_ignition"] == pytest.approx(0.0, abs=1e-12)


def test_priming_time_and_ramp_of_an_inertance_only_line():
    """No loss, no valve travel, no dump: m = dp t/I, so the volume V fills at t = sqrt(2 I rho V / dp),
    and the column keeps ramping at dp/I once it is primed (no injector loss, no ignition)."""
    I, rho, V, dp = 1495.0, 1150.0, 2.4e-5, 578.0 * PSI - 94069.7
    ox = _line("ox", I_up=I, R_up=0.0, R_valve_open=0.0, travel_s=0.0, I_dn=0.0, V_dn_line=0.0, R_dn=0.0,
               V_manifold=V, K_exit_prime=0.0, I_inj=0.0, phi=math.inf)
    fu = _line("fuel", t_open=math.inf)
    run = S.run_start(ox, fu, _chamber(), dt=1e-5, horizon_s=0.02)
    assert not run["ignited"]
    assert run["t_prime"][0] == pytest.approx(math.sqrt(2 * I * rho * V / dp), rel=1e-3)
    t_last, _, m_inj, _ = run["trace"][-1]
    assert run["line_end"][0] == pytest.approx(dp * t_last / I, rel=1e-6)
    assert m_inj == pytest.approx(dp * t_last / I, rel=1e-6)


def test_priming_against_a_borda_dump_runs_at_the_terminal_velocity():
    """No inertance upstream, no loss but the K velocity heads at the front: the growing column starts
    at its terminal velocity v = sqrt(2 dp / (rho K)) (Liou & Hunt's rigid-column equation with
    l = 0) and fills a tube of length L at t = L / v."""
    rho, A, L = 1150.0, math.pi * 10.92e-3 ** 2 / 4, 0.5
    dp = 578.0 * PSI - 94069.7
    for K in (1.0, 2.0):
        ox = _line("ox", rho=rho, I_up=0.0, R_up=0.0, R_valve_open=0.0, travel_s=0.0, I_dn=L / A, V_dn_line=A * L,
                   R_dn=0.0, V_manifold=0.0, A_exit=A, K_exit_prime=K, I_inj=0.0, phi=math.inf)
        run = S.run_start(ox, _line("fuel", t_open=math.inf), _chamber(), dt=1e-6, horizon_s=0.02)
        assert run["t_prime"][0] == pytest.approx(L / math.sqrt(2 * dp / (rho * K)), rel=1e-3)
        assert run["arrival_mdot"][0] == pytest.approx(rho * A * math.sqrt(2 * dp / (rho * K)), rel=1e-6)


def test_priming_inertance_grows_with_the_filled_length():
    """No loss, a column of fixed length L_u filling a tube of the same bore: rho (L_u + x) dv/dt = dp,
    so v^2 = (2 dp / rho) ln((L_u + x)/L_u) and the tube of length L_d fills at
    t = L_u sqrt(rho / (2 dp)) sqrt(pi) erfi(sqrt(ln((L_u + L_d)/L_u)))."""
    from scipy.special import erfi

    rho, A, Lu, Ld = 1150.0, math.pi * 10.92e-3 ** 2 / 4, 0.14, 0.5
    dp = 578.0 * PSI - 94069.7
    ox = _line("ox", rho=rho, I_up=Lu / A, R_up=0.0, R_valve_open=0.0, travel_s=0.0, I_dn=Ld / A, V_dn_line=A * Ld,
               R_dn=0.0, V_manifold=0.0, A_exit=A, K_exit_prime=0.0, I_inj=0.0, phi=math.inf)
    run = S.run_start(ox, _line("fuel", t_open=math.inf), _chamber(), dt=1e-6, horizon_s=0.02)
    t_fill = Lu * math.sqrt(rho / (2 * dp)) * math.sqrt(math.pi) * erfi(math.sqrt(math.log((Lu + Ld) / Lu)))
    assert run["t_prime"][0] == pytest.approx(t_fill, rel=2e-3)
    v_end = math.sqrt(2 * dp / rho * math.log((Lu + Ld) / Lu))
    assert run["arrival_mdot"][0] == pytest.approx(rho * A * v_end, rel=2e-3)


def test_primed_line_carries_the_orifice_inertance():
    """Primed at Fire, no loss: the whole column, tube and orifice passages, ramps at dp / (I_up + I_dn + I_inj)."""
    dp = 578.0 * PSI - 94069.7
    ox = _line("ox", R_up=0.0, R_valve_open=0.0, travel_s=0.0, R_dn=0.0, V_dn_line=0.0, V_manifold=0.0,
               I_up=747.0, I_dn=747.0, I_inj=163.0, phi=math.inf)
    run = S.run_start(ox, _line("fuel", t_open=math.inf), _chamber(), dt=1e-5, horizon_s=0.01)
    t_last = run["trace"][-1][0]
    assert run["line_end"][0] == pytest.approx(dp * t_last / (747.0 + 747.0 + 163.0), rel=1e-9)


def test_settled_state_is_the_algebraic_operating_point():
    """With the valves full open, the start settles on m_s = sqrt((p_T - Pc)/R_s) and Pc At/c* = m_o + m_f."""
    ox, fu = _line("ox"), _line("fuel", I_up=9700.0, phi=1.19e-3)
    ch = _chamber()
    run = S.run_start(ox, fu, ch, dt=1e-5, horizon_s=0.15)

    def r_tot(ln):
        return ln.R_up + ln.R_valve_open + ln.R_dn + 1.0 / ln.phi ** 2

    def g(pc):
        mo = math.sqrt((ox.p_tank - pc) / r_tot(ox))
        mf = math.sqrt((fu.p_tank - pc) / r_tot(fu))
        return pc * ch.throat_area / 1570.0 - (mo + mf)

    pc = brentq(g, 1e5, 578.0 * PSI - 1.0)
    assert run["pc_end"] == pytest.approx(pc, rel=1e-4)
    assert run["mdot_end"][0] == pytest.approx(math.sqrt((ox.p_tank - pc) / r_tot(ox)), rel=1e-4)
    assert run["F_end"] == pytest.approx(2320.0 * pc * ch.throat_area / 1570.0 - ch.ambient_pa * ch.exit_area,
                                         rel=1e-4)
    assert run["t_settle"] is not None and run["t_settle"] < 0.1


def test_hard_start_pair_and_spike():
    """Both primed at Fire (no gas volume), ignition delayed by tau: the pair injected before ignition,
    burned at once in the chamber volume, gives a spike m (Gamma c*)^2 / V."""
    tau = 4e-3
    ox = _line("ox", V_dn_line=0.0, V_manifold=0.0, travel_s=0.0)
    fu = _line("fuel", V_dn_line=0.0, V_manifold=0.0, travel_s=0.0, I_up=9700.0, phi=1.19e-3)
    ch = _chamber(ignition_delay_s=tau)
    run = S.run_start(ox, fu, ch, dt=1e-6, horizon_s=0.02)
    mo, mf = run["pre_ignition_kg"]
    pair = min(mo, 1.52 * mf) * (1 + 1 / 1.52)
    assert run["pair_kg"] == pytest.approx(pair, rel=1e-9)
    G = S.gamma_function(1.135)
    assert run["spike_pa"] == pytest.approx(pair * (G * 1570.0) ** 2 / 2.44e-3, rel=1e-9)
    assert run["t_ignition"] == pytest.approx(tau, abs=1e-12)
    # the pre-ignition masses are the flows integrated over tau (ox: quasi-steady at full open)
    m_ox_q = math.sqrt((ox.p_tank - ch.ambient_pa) / (ox.R_up + ox.R_valve_open + ox.R_dn + 1 / ox.phi ** 2))
    assert mo < m_ox_q * tau and mo > 0.3 * m_ox_q * tau


def test_fixed_load_deficit_closed_forms():
    F, mo, mf = 6750.0, 1.85, 1.22
    c = F / (mo + mf)
    mr = mo / mf
    dt = 1e-4

    def trace(delay, lead=0.0, q_lead=0.0):
        out = []
        t = -lead
        while t <= 0.2 + 1e-12:
            if t < 0.0:
                out.append((t, 0.0, 0.0, q_lead))
            elif t < delay:
                out.append((t, 0.0, 0.0, 0.0))
            else:
                out.append((t, F, mo, mf))
            t += dt
        return out

    kw = dict(F_settled=F, mdot_settled=(mo, mf), c_end=c, mr_end=mr)
    # A start that is already the main burn costs nothing.
    a = S.fixed_load_deficit(trace=trace(0.0), t_window=0.1, residual_extra=(0.0, 0.05), **kw)
    assert a["deficit_Ns"] == pytest.approx(0.0, abs=1e-6)
    # A pure delay costs F*delay over the window, all of it recovered at the end of a fixed load.
    b = S.fixed_load_deficit(trace=trace(0.02), t_window=0.1, residual_extra=(0.0, 0.05), **kw)
    assert b["window_deficit_Ns"] == pytest.approx(F * 0.02, abs=F * dt)  # trapezoid over the step edge
    assert b["deficit_Ns"] == pytest.approx(0.0, abs=0.5)
    # A fuel lead of q*L kg with no thrust: free while the LOX-limited burn strands more fuel than that ...
    c1 = S.fixed_load_deficit(trace=trace(0.0, lead=0.02, q_lead=2.0), t_window=0.1, residual_extra=(0.0, 0.05), **kw)
    assert c1["deficit_Ns"] == pytest.approx(0.0, abs=0.5)
    # ... and (1 + O/F) c (qL - r) once it eats past the stranded fuel.
    c2 = S.fixed_load_deficit(trace=trace(0.0, lead=0.2, q_lead=2.0), t_window=0.1, residual_extra=(0.0, 0.05), **kw)
    assert c2["deficit_Ns"] == pytest.approx(c * (1 + mr) * (2.0 * 0.2 - 0.05), rel=2e-3)


# ------------------------------------------------------------------ shutdown


from engine.layerx.diag import shutdown as SD  # noqa: E402


def _tail(key, **kw):
    base = dict(key=key, rho=1150.0 if key == "ox" else 792.8, mdot0=1.9 if key == "ox" else 1.3,
                V_up=7.6e-6, V_dn=2.4e-5, travel_s=0.05, R_valve_open=2213.0, R_rest=3.6e5)
    base.update(kw)
    return SD.TailSide(**base)


def test_wet_side_with_an_instant_shut_drains_exactly_its_downstream_liquid():
    dt = 1e-5
    a = _tail("ox", travel_s=0.0)
    b = _tail("fuel", travel_s=0.0, V_dn=4.7e-5)
    tail = SD.tail_off(a, b, t0=1.0, t_cmd=1.0, dt=dt)
    for s in (a, b):
        side = tail["sides"][s.key]
        assert side["delivered_kg"] == pytest.approx(s.rho * s.V_dn, rel=1e-9)
        assert side["t_end"] == pytest.approx(1.0 + s.rho * s.V_dn / s.mdot0, abs=2 * dt)


def test_dry_side_pushes_its_whole_line_through_when_never_shut():
    dt = 1e-5
    a = _tail("ox", wet=False)
    tail = SD.tail_off(a, _tail("fuel"), t0=0.0, t_cmd=10.0, dt=dt, horizon_s=0.0)
    side = tail["sides"]["ox"]
    stock = a.rho * (a.V_up + a.V_dn)
    assert side["delivered_kg"] == pytest.approx(stock, rel=1e-9)
    assert side["t_end"] == pytest.approx(stock / a.mdot0, abs=2 * dt)


def test_closing_valve_alone_delivers_half_the_travel():
    """Valve the only loss, linear Cv: the quasi-steady flow falls linearly with travel, so the
    closure passes m0 * travel / 2, then the downstream liquid drains."""
    dt = 1e-6
    s = _tail("fuel", R_rest=0.0)
    assert s.closing_fraction(0.3) == pytest.approx(0.3, rel=1e-12)
    tail = SD.tail_off(s, _tail("ox"), t0=0.0, t_cmd=0.0, dt=dt)
    assert tail["sides"]["fuel"]["delivered_kg"] == pytest.approx(s.mdot0 * s.travel_s / 2 + s.rho * s.V_dn,
                                                                   rel=1e-4)
    # with the rest of the line in series the valve takes over only near the seat
    s2 = _tail("fuel")
    x = 0.1
    assert s2.closing_fraction(x) == pytest.approx(
        math.sqrt((s2.R_rest + s2.R_valve_open) / (s2.R_rest + s2.R_valve_open / x ** 2)), rel=1e-12)


def test_mode_and_alone_mass_closed_form():
    """LOX runs dry with no downstream volume and a late command D: LOX ends at rho V_up / m_ox, fuel
    flows until D then drains rho_f V_dn_f. Fuel alone = m_f (D - t_ox) + rho_f V_dn_f."""
    dt, D = 1e-5, 0.08
    ox = _tail("ox", wet=False, V_dn=0.0, travel_s=0.0)
    fu = _tail("fuel", travel_s=0.0, V_dn=4.7e-5)
    tail = SD.tail_off(ox, fu, t0=0.0, t_cmd=D, dt=dt)
    cls = SD.classify(tail)
    t_ox = ox.rho * ox.V_up / ox.mdot0
    assert cls["mode"] == "fuel-rich" and cls["lox_alone_kg"] == 0.0
    assert cls["end_ox_s"] == pytest.approx(t_ox, abs=2 * dt)
    assert cls["alone_kg"] == pytest.approx(fu.mdot0 * (D - t_ox) + fu.rho * fu.V_dn, rel=2e-3)
    assert cls["tail_mr_max"] == pytest.approx(ox.rho * ox.V_up / (fu.mdot0 * D + fu.rho * fu.V_dn), rel=2e-3)
    # The other way round: fuel dry first and a late command, so LOX flows alone (LOX-rich).
    ox2 = _tail("ox", travel_s=0.0, V_dn=2.4e-5)
    fu2 = _tail("fuel", wet=False, travel_s=0.0, V_up=1e-5, V_dn=0.0)
    cls2 = SD.classify(SD.tail_off(ox2, fu2, t0=0.0, t_cmd=D, dt=dt))
    t_fu = fu2.rho * fu2.V_up / fu2.mdot0
    assert cls2["mode"] == "LOX-rich"
    assert cls2["lox_alone_kg"] == pytest.approx(ox2.mdot0 * (D - t_fu) + ox2.rho * ox2.V_dn, rel=2e-3)
    assert SD._note("LOX-rich", cls2)["grade"] == "warn"


# ------------------------------------------------------------------ water hammer


from engine.layerx.diag import waterhammer as WH  # noqa: E402

# LOX at 3.985 MPa, 90 K (CoolProp 7.2.0 through feedtwin Fluid('oxygen')): rho, sound speed.
LOX_RHO, LOX_A = 1150.5066, 924.2572


def test_korteweg_wave_speed_against_the_audit_hand_value():
    """AUDIT 9.5 §5 by hand: LOX in 1/2 x 0.035 in 316 tube, a = 897 m/s."""
    a = WH.wave_speed(LOX_A, LOX_RHO, 10.92e-3, 0.889e-3, 193e9, 1.0)
    assert a == pytest.approx(897.0, abs=1.5)
    assert WH.wave_speed(LOX_A, LOX_RHO, 10.92e-3, 0.889e-3, math.inf) == LOX_A
    # Joukowsky at the audit's v = 17.4 m/s: 2607 psi
    assert WH.joukowsky(LOX_RHO, 897.0, 17.4) / PSI == pytest.approx(2607.0, rel=2e-3)


def _pipe(**kw):
    base = dict(rho=LOX_RHO, a=897.0, bore=10.92e-3, length=0.9, p_tank=578.0 * PSI, mdot0=1.9)
    base.update(kw)
    return WH.Pipeline(**base)


def test_moc_holds_a_steady_state():
    pipe = _pipe(R_entry=2.0e4, R_friction=1.0e4)
    sim = WH.moc(pipe, t_end=0.01, valve_R=lambda t: 3.6e5)
    assert sim["p_max"] - sim["p_min"] < 1e-6 * sim["p0_valve"]


def test_moc_instant_closure_is_joukowsky():
    pipe = _pipe()
    v0 = pipe.mdot0 / (pipe.rho * pipe.area)
    sim = WH.moc(pipe, t_end=8 * pipe.length / pipe.a, valve_R=lambda t: math.inf if t > 0 else 3.6e5,
                 R_down0=3.6e5)
    assert sim["p_max"] - sim["p0_valve"] == pytest.approx(pipe.rho * pipe.a * v0, rel=1e-9)
    # and the line rings as a square wave of period 4L/a: +J for 0 < t < 2L/a, -J for 2L/a < t < 4L/a
    J, T = pipe.rho * pipe.a * v0, 4 * pipe.length / pipe.a
    for t, p in zip(sim["t"], sim["p_valve"]):
        if 0.05 * T < t < 0.45 * T:
            assert p - sim["p0_valve"] == pytest.approx(J, rel=1e-9)
        elif 0.55 * T < t < 0.95 * T:
            assert p - sim["p0_valve"] == pytest.approx(-J, rel=1e-9)


def test_moc_linear_velocity_closure_is_michaud():
    """Frictionless, the velocity at the valve brought down linearly over t_c > 2L/a: peak 2 rho L v0 / t_c."""
    pipe = _pipe()
    tc = 10 * 2 * pipe.length / pipe.a
    sim = WH.moc(pipe, t_end=2 * tc, n_reaches=32,
                 valve_flow=lambda t: pipe.mdot0 * max(1.0 - t / tc, 0.0))
    v0 = pipe.mdot0 / (pipe.rho * pipe.area)
    assert sim["p_max"] - sim["p0_valve"] == pytest.approx(2 * pipe.rho * pipe.length * v0 / tc, rel=1e-2)
    assert WH.michaud(pipe.rho, pipe.length, v0, tc, pipe.a) == pytest.approx(2 * pipe.rho * pipe.length * v0 / tc)
    assert WH.michaud(pipe.rho, pipe.length, v0, 0.5 * pipe.length / pipe.a, pipe.a) == pytest.approx(
        pipe.rho * pipe.a * v0)
    # inside the round trip 2L/a (not just L/a) the closure is "rapid": Joukowsky
    assert WH.michaud(pipe.rho, pipe.length, v0, 1.5 * pipe.length / pipe.a, pipe.a) == pytest.approx(
        pipe.rho * pipe.a * v0)


def test_opening_surge_boundary_limits_and_hand_case():
    B, m_arr, pa = 9.6e6, 4.9, 94000.0
    assert WH.opening_surge(p_front=pa, pc=pa, mdot_arrival=m_arr, phi=math.inf, B=B)["p_peak"] == pytest.approx(pa)
    assert WH.opening_surge(p_front=pa, pc=pa, mdot_arrival=m_arr, phi=1e-12, B=B)["p_peak"] == pytest.approx(
        pa + B * m_arr, rel=1e-6)
    phi = 1.73e-3
    o = WH.opening_surge(p_front=pa, pc=pa, mdot_arrival=m_arr, phi=phi, B=B)
    # by hand: m^2/phi^2 + B m = B m_arr, the orifice drop equal to the Joukowsky rise
    m = (-B + math.sqrt(B * B + 4 * B * m_arr / phi ** 2)) / (2 / phi ** 2)
    assert o["mdot_after"] == pytest.approx(m, rel=1e-9)
    assert o["p_peak"] - pa == pytest.approx((m / phi) ** 2, rel=1e-9)


# ------------------------------------------------------------------ outflow (gas ingestion)


from engine.layerx.diag import outflow as OF  # noqa: E402


def test_lubin_springer_constant_is_the_point_sink_minimum():
    """h(z) = z + Q^2/(8 pi^2 g z^4) over a hemispherical sink: its minimum is h_c; the constant
    0.69 of Lubin & Springer is that minimum over (Q^2/g)^(1/5)."""
    from scipy.optimize import minimize_scalar

    Q, g = 1.73e-3, 9.80665
    res = minimize_scalar(lambda z: z + Q * Q / (8 * math.pi ** 2 * g * z ** 4), bounds=(1e-4, 1.0), method="bounded",
                          options={"xatol": 1e-12})
    scale = (Q * Q / g) ** 0.2
    assert res.fun / scale == pytest.approx(OF.point_sink_constant(), rel=1e-6)
    assert OF.point_sink_constant() == pytest.approx(OF.LS_CONSTANT, rel=3e-3)
    assert OF.critical_height(Q, g, 1150.0) == pytest.approx(0.69 * scale, rel=1e-12)


def test_critical_height_scales_with_flow_gravity_and_density_ratio():
    Q, g = 1.73e-3, 9.80665
    h = OF.critical_height(Q, g, 1150.0)
    assert OF.critical_height(2 * Q, g, 1150.0) == pytest.approx(h * 2 ** 0.4, rel=1e-12)
    assert OF.critical_height(Q, 9 * g, 1150.0) == pytest.approx(h * 9 ** -0.2, rel=1e-12)
    # gas half as dense as the liquid halves the buoyant gravity: h_c up by 2^(1/5)
    assert OF.critical_height(Q, g, 1150.0, 575.0) == pytest.approx(h * 2 ** 0.2, rel=1e-12)


def test_head_volumes_and_their_inverse():
    R = 0.08
    assert OF.volume_below(R, R, R) == pytest.approx(2 / 3 * math.pi * R ** 3, rel=1e-12)       # hemisphere
    assert OF.volume_below(R / 2, R, R / 2) == pytest.approx(2 / 3 * math.pi * R * R * R / 2, rel=1e-12)  # 2:1 head
    assert OF.volume_below(0.03, R, 0.0) == pytest.approx(math.pi * R * R * 0.03, rel=1e-12)
    # a spherical cap: pi h^2 (R - h/3)
    assert OF.volume_below(0.03, R, R) == pytest.approx(math.pi * 0.03 ** 2 * (R - 0.01), rel=1e-12)
    for b in (0.0, R / 2, R):
        for h in (0.004, 0.03, 0.2):
            assert OF.liquid_height(OF.volume_below(h, R, b), R, b) == pytest.approx(h, rel=1e-9)


def test_onset_of_a_steady_drain_from_a_flat_tank():
    """Constant flow from a flat-bottomed tank: the level falls linearly and h_c is constant, so the
    dip forms at t = (M - rho pi R^2 h_c) / mdot with rho pi R^2 h_c left."""
    rho, R, md, M, g = 1150.0, 0.08, 1.9, 6.6, 9.80665
    t = [0.05 * k for k in range(1, 70)]
    liq = [M - md * ti for ti in t]
    on = OF.onset(t, liq, [md] * len(t), [g] * len(t), rho_liquid=[rho] * len(t), rho_gas=[0.0] * len(t),
                  radius=R, head_depth=0.0)
    hc = 0.69 * ((md / rho) ** 2 / g) ** 0.2
    m_c = rho * math.pi * R * R * hc
    assert on["residual_kg"] == pytest.approx(m_c, rel=1e-6)
    assert on["t"] == pytest.approx((M - m_c) / md, rel=1e-6)
    # never reached when the burn ends first
    off = OF.onset(t[:10], liq[:10], [md] * 10, [g] * 10, rho_liquid=[rho] * 10, rho_gas=[0.0] * 10,
                   radius=R, head_depth=0.0)
    assert off["t"] is None and off["residual_kg"] is None


# ------------------------------------------------------------------ LE4 (slow: LAYERX_GOLDEN=1)


GOLDEN = os.environ.get("LAYERX_GOLDEN") == "1"
slow = pytest.mark.skipif(not GOLDEN, reason="LE4 prepare + he_pad burn (~1-2 min); set LAYERX_GOLDEN=1")


@pytest.fixture(scope="module")
def le4():
    import copy
    import importlib.util
    from pathlib import Path

    from engine.core.runner import PintleEngineRunner
    from engine.layerx import LayerXSettings, prepare, run_prepared

    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location("layerx_baseline", root / "scripts" / "layerx_baseline.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    cfg, _ = mod.load_engine_config(root / "docs" / "layerx" / "baseline-2026-10-02.json")
    drawing = mod.find_drawing("copv_study_he")
    burned = copy.deepcopy(cfg)
    runner = PintleEngineRunner(burned)
    prep = prepare(burned, runner, drawing, LayerXSettings(drawing_id=drawing.id), [])
    result = run_prepared(prep, runner=runner, replay=prep.settings.replay, config=burned,
                          progress=lambda stage, frac: None)
    return prep, result, burned


@slow
def test_le4_feed_geometry_matches_the_audit_hand_values(le4):
    """AUDIT 9.5 §1, by hand from the drawing: line inertance sum L/A = 1495 (LOX, 0.14 m) and
    10297 1/m (fuel, 0.964 m) of 10.92 mm bore; orifice passages 163 / 200 1/m (24 x 8.16 mm)."""
    prep, result, cfg = le4
    sp = S.settled_point(result)
    ox = S.feed_line(prep, "oxidiser", mdot_ref=sp["line_ox"], p_ref=578 * PSI, T_ref=90.0)
    fu = S.feed_line(prep, "fuel", mdot_ref=sp["line_fu"], p_ref=578 * PSI, T_ref=293.15)
    assert ox.sum("up", "inertance") + ox.sum("dn", "inertance") == pytest.approx(1495.0, abs=1.0)
    assert fu.sum("up", "inertance") + fu.sum("dn", "inertance") == pytest.approx(10297.0, abs=5.0)
    assert ox.valve.id == "MVO" and fu.valve.id == "MVF" and ox.valve.travel_s == pytest.approx(0.05)
    man = S.manifold_volumes(cfg)
    assert man["ox"]["I_inj"] == pytest.approx(163.0, abs=1.0)
    assert man["fuel"]["I_inj"] == pytest.approx(200.0, abs=1.0)
    # the drawn tank-exit K 0.5 and the line friction: the audit's 14.69 psi LOX line loss
    # (AUDIT 1, hand) is the drawn loss at ~1.88 kg/s; the twin's own element losses give it
    dp_line = (ox.sum("up", "R") + ox.valve.R + ox.sum("dn", "R")) * 1.879 ** 2 / PSI
    assert 5.0 < dp_line < 20.0


@slow
def test_le4_diagnostics_run_on_the_golden_burn_and_leave_it_alone(le4):
    import copy

    from engine.layerx.diag import outflow as OFm, shutdown as SDm, waterhammer as WHm

    prep, result, cfg = le4
    before = copy.deepcopy(result)
    st = S.start_from_run(prep, result, cfg)
    assert st["available"], st.get("error")
    assert 0.0 < st["prime_ox_s"] < st["prime_fuel_s"] < 0.05
    assert st["ignition_s"] == pytest.approx(st["prime_fuel_s"])
    assert 0.0 < st["impulse_deficit_pct"] < 1.5
    assert abs(st["steady_check"]["thrust_rel"]) < 0.01
    assert len(st["t"]) == len(st["pc_psia"]) == len(st["mdot_ox"]) == len(st["mr"])
    of = OFm.outflow_from_run(prep, result)
    assert all(r["available"] for r in of)
    sd = SDm.shutdown_from_run(prep, result, cfg, outflow=of)
    assert sd["available"] and sd["first_dry"] in ("ox", "fuel") and sd["mode"] in ("LOX-rich", "fuel-rich",
                                                                                     "simultaneous")
    wh = WHm.waterhammer_from_run(prep, result, cfg, start=st)
    assert [r["side"] for r in wh] == ["ox", "fuel"] and all(r["available"] for r in wh)
    # Joukowsky by hand at the burn's largest LOX flow: rho a v with a = 897 m/s
    r_ox = wh[0]
    v = r_ox["v0_m_s"]
    assert r_ox["joukowsky_psi"] == pytest.approx(1150.5 * 897.0 * v / PSI, rel=0.01)
    import json

    for block in [st, sd, *of, *wh]:
        assert {"name", "source", "assumptions", "inputs"} <= set(block["model"])
        json.dumps(block, allow_nan=False)      # the run record is strict JSON
    assert result == before
