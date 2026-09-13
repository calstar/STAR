"""The steady network solve: pressure at every node, flow in every branch.

The system is small, square and highly structured. Unknowns are one pressure per
free node and one mass flow per branch; equations are one mass balance per free
node and one pressure relation per branch::

    node i    :  sum(flows in) - sum(flows out) - demand = 0
    branch b  :  (p_up - p_dn) - dp(mdot) = 0

Almost all of the Jacobian is constant. The mass-balance rows are the incidence
matrix -- plus and minus ones that never change. The branch rows are +1 on the
upstream pressure, -1 on the downstream, and a single nonlinear entry:
``d(dp)/d(mdot)``, one scalar per branch. So a Newton step costs one derivative
per component and a sparse solve, and nothing has to differentiate a correlation.

Two things about this problem bite, and both are handled explicitly rather than
hoped away:

**Zero flow is a singular point.** Loss goes as roughly ``mdot^2``, so its
derivative vanishes at zero and the branch row goes with it. A guess that starts
at zero flow cannot take a first step. Solved by starting away from zero and by
flooring the derivative -- see :data:`MIN_BRANCH_SLOPE`.

**Newton overshoots.** An undamped step from a poor guess can send a pressure
negative, at which point the property layer refuses and rightly so. Solved with
backtracking: halve the step until the residual actually improves.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Iterable, Mapping

import numpy as np
from scipy.sparse import csc_matrix
from scipy.sparse.linalg import splu

from feedtwin.comps import Violation
from feedtwin.solve.network import DeadEnd, Network, NetworkError

#: Floor on ``|d(dp)/d(mdot)|`` [Pa/(kg/s)] when building the Jacobian.
#:
#: A regularisation, and named as one. Quadratic losses have zero slope at zero
#: flow, which makes that branch's row singular; without a floor a network
#: containing a shut valve cannot take a Newton step. It biases nothing at the
#: solution -- it only appears where the true slope is smaller than this, which
#: is to say where the branch is carrying essentially nothing -- and
#: :attr:`SteadyResult.regularised_branches` reports every branch where it was
#: still active at convergence, so it can never be silently load-bearing.
MIN_BRANCH_SLOPE = 1.0e-3

#: Relative perturbation for the finite-difference derivative.
_FD_REL = 1.0e-6
_FD_ABS = 1.0e-9


@dataclass(frozen=True, slots=True)
class SteadyResult:
    """What a converged (or failed) steady solve produced."""

    pressures: dict[str, float]
    """Pressure at every node [Pa], fixed nodes included."""

    flows: dict[str, float]
    """Mass flow in every branch [kg/s], positive upstream to downstream."""

    converged: bool
    iterations: int
    residual_norm: float
    """Infinity norm of the final residual, scaled by each row's own magnitude
    so it is dimensionless. :attr:`mass_residuals` is the physical measure."""

    mass_residuals: dict[str, float] = field(default_factory=dict)
    """Net mass imbalance at each free node [kg/s]. Reported on every run,
    never assumed: a solve that converged on a system that does not conserve
    mass has found the wrong answer confidently."""

    diagnostics: dict[str, dict[str, float]] = field(default_factory=dict)
    """Per-branch derived quantities -- velocity, Reynolds number, regime."""

    violations: list[Violation] = field(default_factory=list)
    dead_ends: list[str] = field(default_factory=list)
    """Branches carrying no flow by construction -- transducer ports, capped
    fill lines, shut reliefs. Solved exactly rather than iterated, and listed
    here so it is visible which parts of the network took no part."""

    indeterminate_dead_ends: list[str] = field(default_factory=list)
    """Stubs whose pressure is genuinely not defined at zero flow, because the
    component still holds a drop there -- a check valve behind its cracking
    pressure, or a regulator with nothing drawing through it. Their node
    pressure is reported as the live end's and should be read as an upper
    bound, not a solution."""

    indeterminate_nodes: list[str] = field(default_factory=list)
    """The *nodes* those stubs hang off, which is what a caller displaying a
    transducer needs. Reported alongside the branch ids rather than instead of
    them because the two are used for different things, and a caller that
    reached for one and got the other silently showed the wrong pressure on
    every trapped line."""

    regularised_branches: list[str] = field(default_factory=list)
    """Branches where the derivative floor was still active at convergence.
    Usually means a branch carrying essentially no flow, which is worth knowing
    and is exactly what a shut valve looks like."""

    choked_branches: list[str] = field(default_factory=list)
    """Branches solved as ``mdot = ceiling`` rather than ``dp = f(mdot)``,
    because the available drop took them past choking. Reported because it
    changes what the answer means: opening the downstream side further buys
    nothing, and the pressure downstream of one of these is not set by this
    branch at all."""

    elapsed: float = 0.0
    stack: dict[str, str | None] = field(default_factory=dict)
    """Versions of the physics stack that produced this, for reproducibility."""

    @property
    def max_mass_residual(self) -> float:
        return max((abs(v) for v in self.mass_residuals.values()), default=0.0)

    def dp(self, branch_id: str, network: Network) -> float:
        """Pressure drop across one branch [Pa], from the solved pressures."""
        branch = network.branches[branch_id]
        return self.pressures[branch.upstream] - self.pressures[branch.downstream]


class ConvergenceError(RuntimeError):
    """Newton did not converge, with what it was doing when it gave up."""

    def __init__(self, result: SteadyResult, detail: str) -> None:
        super().__init__(
            f"the steady solve did not converge after {result.iterations} "
            f"iterations (residual {result.residual_norm:.3e}): {detail}"
        )
        self.result = result


def solve_steady(
    network: Network,
    *,
    tol: float = 1.0e-6,
    max_iterations: int = 100,
    initial_flow: float = 1.0e-3,
    raise_on_failure: bool = True,
    signals: Mapping[str, float] | None = None,
    guess: Mapping[str, float] | None = None,
    isolate: Iterable[str] | None = None,
) -> SteadyResult:
    """Solve a network for its steady operating point.

    Args:
        network: The system. Validated first.
        tol: Convergence tolerance on the scaled residual.
        max_iterations: Newton iteration cap.
        initial_flow: Starting flow for every branch [kg/s]. Non-zero on
            purpose -- see the module docstring.
        raise_on_failure: Raise :class:`ConvergenceError` on failure. Set false
            to inspect a failed result instead, which is what a sweep wants.
        isolate: Extra branches to treat as open circuits, on top of the
            valves that report themselves shut. For what a caller knows and the
            network cannot -- an empty tank's outlet being the case.
        guess: Starting point, as ``{node or branch id: pressure or flow}``.
            A transient re-solves the same network a few thousand times at
            states that barely differ, and starting each one from a cold
            1e-3 kg/s throws that away -- it costs iterations, and on a stiff
            network it can land the search in a different basin than the step
            before, which reads as a convergence failure at one instant and
            nowhere else. Unknown ids are ignored, so a guess from a slightly
            different network is safe to pass.
        signals: Control inputs -- ``{"MV-01.command": 0.4}`` for a part-open
            valve. Every component that reads a signal sees the same mapping,
            so a scenario's timeline reaches the physics without the solver
            knowing what any particular signal means. Omitted, each component
            falls back to its own default, which for a valve is fully open.

    Returns:
        A :class:`SteadyResult`, including mass-conservation residuals whether
        or not it converged.
    """
    started = time.perf_counter()
    network.validate()

    # A valve commanded shut is an open circuit, not a very small orifice, so
    # it leaves the unknowns entirely -- and taking it out is usually what makes
    # the rest of its line a stub. See Network.isolated.
    # Shut valves, plus anything the caller knows cannot flow. A live session
    # adds the feed lines of a tank that has run dry: the network would happily
    # keep pushing pressure-driven flow out of an empty vessel, because nothing
    # in a pressure boundary knows there is nothing left behind it.
    isolated = network.isolated(signals) | set(isolate or ())

    # Stubs carry no flow by mass balance, so they are removed from the unknowns
    # and back-filled exactly afterwards. Most of a real feed system is stubs.
    stubs = network.dead_ends(exclude=isolated)
    stub_nodes = {d.node for d in stubs}
    stub_branches = {d.branch for d in stubs} | isolated

    free = [n for n in network.free_nodes if n not in stub_nodes]
    branch_ids = [b for b in network.branches if b not in stub_branches]
    node_index = {n: i for i, n in enumerate(free)}
    branch_index = {b: len(free) + i for i, b in enumerate(branch_ids)}
    n_unknowns = len(free) + len(branch_ids)

    if n_unknowns == 0:
        # Every branch is a stub or a shut valve, so nothing flows anywhere.
        # That is not a degenerate network -- it is a stand sitting in Armed
        # with the whole panel closed, which is where a stand spends most of its
        # life. The answer is zero flow and back-filled pressures, and raising
        # here made the most ordinary state on the pad an error.
        return _result(
            network,
            np.zeros(0),
            True,
            0,
            0.0,
            started,
            stubs,
            isolated,
        )

    x = _initial_guess(network, free, branch_ids, initial_flow)
    if guess:
        for node_id, row in node_index.items():
            value = guess.get(node_id)
            if value is not None and value > 0.0:
                x[row] = value
        for branch_id, row in branch_index.items():
            value = guess.get(branch_id)
            if value is not None:
                x[row] = value
    scale = _row_scales(network, free, branch_ids, initial_flow)

    rows, cols = _incidence_pattern(network, node_index, branch_index)

    converged = False
    residual = np.zeros(n_unknowns)
    iterations = 0
    unresolvable = np.zeros(n_unknowns, dtype=bool)

    for iterations in range(1, max_iterations + 1):
        # One pass builds both halves. A `_BranchRow` carries the residual *and*
        # its derivatives precisely so that the finite differences behind them
        # are taken once; computing the residual and the Jacobian in separate
        # passes doubled the number of component evaluations, which on a
        # five-branch transient was most of the run time.
        try:
            branch_rows = _branch_rows(network, x, node_index, branch_index, signals)
            residual = _assemble_residual(
                network, x, node_index, branch_index, branch_rows
            )
        except Exception:  # noqa: BLE001
            # Same contract as the update below: a component refusing the point
            # the last step landed on is a failed solve, not a crash. Guarding
            # only the update left this evaluation as the one place an
            # unreachable operating point could still escape a solve the caller
            # asked not to raise -- and it is the place it actually escaped
            # from, because the update's own backtracking hands back a
            # last-resort step it never got to evaluate.
            converged = False
            break
        unresolvable[:] = False
        for branch_id, branch_row in branch_index.items():
            entry = branch_rows[branch_id]
            if not entry.choked and abs(entry.d_mdot) < MIN_BRANCH_SLOPE:
                unresolvable[branch_row] = True
        norm = _scaled_norm(residual, scale, unresolvable)
        if norm < tol:
            # A residual can go to zero on a state that is not a pressure.
            #
            # Newton knows nothing about absolute zero; a stiff branch -- a
            # regulator's reverse-flow stiffness, say -- can hand it a step that
            # lands a node at a large negative pressure, and the residual there
            # is perfectly small. Nothing downstream survives it: the back-fill
            # asks the property layer for a fluid at -6428 bar and CoolProp is
            # the thing that finally objects, several frames from the cause,
            # after the solve has already been reported as converged.
            #
            # An absolute pressure at or below zero is not a solution, so this
            # is a failed solve like any other and is reported as one.
            if _physical(x, free):
                converged = True
                break
            if not raise_on_failure:
                converged = False
                break
            raise ConvergenceError(
                _result(network, x, False, iterations, norm, started, stubs, isolated),
                "the residual converged on a state with a non-physical "
                f"pressure ({min(x[: len(free)]) / 1e5:.3g} bar absolute). A "
                "branch is almost certainly stiff enough to have thrown the "
                "step past zero -- check for reverse flow through a regulator "
                "or a relief valve.",
            )

        jac = _jacobian(network, node_index, branch_index, branch_rows, rows, cols)

        try:
            step = splu(jac).solve(-residual)
        except (RuntimeError, ValueError) as exc:
            # Same contract as the two guards around it: a caller that asked
            # not to be raised at must not be raised at. A singular Jacobian is
            # a failed solve like any other -- the live cockpit holds its last
            # good answer through it and the next tick usually factorises fine,
            # whereas an exception here kills the run at the instant it is
            # meant to be showing something.
            if not raise_on_failure:
                converged = False
                break
            raise ConvergenceError(
                _result(network, x, False, iterations, norm, started, stubs, isolated),
                f"the Jacobian could not be factorised ({exc}). This usually "
                "means a node with no path to a fixed pressure.",
            ) from exc

        try:
            x = _damped_update(
                network,
                x,
                step,
                residual,
                scale,
                node_index,
                branch_index,
                signals,
                unresolvable,
            )
        except Exception:  # noqa: BLE001 - see below
            # A property call refusing mid-update is a failed solve, not a
            # crash. raise_on_failure=False has to mean it: a live simulation
            # calls this every tick and must be able to hold its last good
            # answer through one hard instant rather than dying at it.
            converged = False
            break

    norm = _scaled_norm(residual, scale, unresolvable)
    result = _result(network, x, converged, iterations, norm, started, stubs, isolated)

    if not converged and raise_on_failure:
        raise ConvergenceError(
            result,
            "the residual stopped improving. Check that flow can actually reach "
            "every node, and that no component is being asked for an operating "
            "point it cannot reach.",
        )
    return result


# ---------------------------------------------------------------------------
# assembly
# ---------------------------------------------------------------------------


def _initial_guess(
    network: Network, free: list[str], branch_ids: list[str], initial_flow: float
) -> np.ndarray:
    """Pressures between the boundary values, flows small but non-zero.

    Deliberately crude. A network solve is not very sensitive to where it starts
    once the first step is possible, and the thing that makes a first step
    impossible is zero flow rather than a poor pressure guess.
    """
    fixed = [network.nodes[n].pressure or 0.0 for n in network.fixed_nodes]
    reference = float(np.mean(fixed)) if fixed else 1.0e5

    x = np.empty(len(free) + len(branch_ids))
    x[: len(free)] = reference
    x[len(free) :] = initial_flow
    return x


def _row_scales(
    network: Network, free: list[str], branch_ids: list[str], initial_flow: float
) -> np.ndarray:
    """A magnitude for each equation, so one tolerance can judge them all.

    The residual vector is in mixed units: mass balances are kg/s, branch
    relations are Pa. Comparing both against a single absolute tolerance means
    ``tol = 1e-6`` demands pressure to a micropascal -- about 1e-12 relative on
    a 30 bar system, which is far below what a finite-difference Jacobian can
    deliver, so the solve grinds without ever "converging".

    Scaling by row does not touch the Newton step -- ``J^-1 F`` is invariant
    under row scaling -- so this changes only the convergence test, and changes
    it from arbitrary to meaningful.
    """
    pressures = [abs(network.nodes[n].pressure or 0.0) for n in network.fixed_nodes]
    p_scale = max(pressures) if pressures else 1.0e5
    demands = [abs(network.nodes[n].demand) for n in free]
    m_scale = max([*demands, initial_flow, 1.0e-3])

    return np.array([m_scale] * len(free) + [p_scale] * len(branch_ids))


def _physical(x: np.ndarray, free: list[str]) -> bool:
    """Are the node pressures in this iterate actually pressures?

    Only the node block of the unknown vector: a *branch* flow is legitimately
    negative, which is just flow the other way.
    """
    return bool(len(free) == 0 or np.all(x[: len(free)] > 0.0))


def _scaled_norm(
    residual: np.ndarray,
    scale: np.ndarray,
    ignore: np.ndarray | None = None,
) -> float:
    """Worst row, scaled. Rows in ``ignore`` are excluded.

    Exclusion is not leniency. A branch whose ``d(dp)/d(mdot)`` has hit
    :data:`MIN_BRANCH_SLOPE` is one the Jacobian *cannot* resolve -- a fully
    open isolation valve carrying zero flow because the regulator downstream is
    holding has a genuinely flat row, and no step size moves it. Letting that
    one row veto the whole solve means a correct answer, with mass closing to
    1e-14, is reported as a failure.

    Two things keep this from hiding a real fault: mass-balance rows are never
    excluded, so conservation still has to hold everywhere; and every excluded
    branch is listed in :attr:`SteadyResult.regularised_branches`, so a solve
    standing on twenty of them says so.
    """
    if residual.size == 0:
        return 0.0
    scaled = np.abs(residual / scale)
    if ignore is not None and ignore.any():
        scaled = scaled[~ignore]
    return float(np.max(scaled)) if scaled.size else 0.0


def _pressure_at(
    network: Network, x: np.ndarray, node_index: dict[str, int], node_id: str
) -> float:
    node = network.nodes[node_id]
    if node.pressure is not None:
        return node.pressure
    return float(x[node_index[node_id]])


@dataclass(frozen=True, slots=True)
class _BranchRow:
    """One branch's equation, and the derivatives the Jacobian needs.

    Two forms, chosen per branch per iteration:

    ``dp``      ``(p_up - p_dn) - dp(mdot) = 0``. The usual one.
    ``choked``  ``K (mdot_ceiling - mdot) = 0``. Written when a component
                reports that the available drop has taken it past choking, at
                which point mass flow no longer depends on downstream pressure
                and the dp form is not invertible. ``K`` carries the row into
                pressure units so it is scaled like its neighbours.
    """

    residual: float
    d_mdot: float
    d_p_up: float
    d_p_dn: float
    choked: bool = False


#: Stiffness [Pa/(kg/s)] converting a choked branch's flow equation into the
#: pressure units the rest of the residual vector is in. Any positive value
#: gives the same root; this one keeps the row's magnitude comparable to a
#: pressure row so the shared convergence test stays meaningful.
_CHOKE_STIFFNESS = 1.0e8


def _branch_row(
    network: Network,
    branch_id: str,
    mdot: float,
    p_up: float,
    p_dn: float,
    signals: Mapping[str, float] | None = None,
) -> _BranchRow:
    """Assemble one branch's equation, in whichever form applies."""
    branch = network.branches[branch_id]
    component = branch.component
    conditions = network.conditions(branch.upstream, p_up, dict(signals or {}))

    available = p_up - p_dn
    ceiling = component.flow_ceiling(conditions)

    def choked_row() -> _BranchRow:
        # Choked: the flow is pinned and downstream pressure is decoupled. The
        # ceiling is proportional to upstream pressure, which is the only
        # pressure this row depends on at all.
        assert ceiling is not None
        return _BranchRow(
            residual=_CHOKE_STIFFNESS * (ceiling - mdot),
            d_mdot=-_CHOKE_STIFFNESS,
            d_p_up=_CHOKE_STIFFNESS * (ceiling / p_up if p_up > 0.0 else 0.0),
            d_p_dn=0.0,
            choked=True,
        )

    # The component reads the pressures and says the drop has carried it past
    # its critical ratio (or, for a regulator, that it has shut -- ceiling 0).
    if ceiling is not None and component.is_choked(available, conditions):
        return choked_row()

    h = max(abs(mdot) * _FD_REL, _FD_ABS)
    try:
        hi = component.total_dp(mdot + h, conditions)
        lo = component.total_dp(mdot - h, conditions)
        slope = (hi - lo) / (2.0 * h)
        drop = component.total_dp(mdot, conditions)
    except Exception:
        # The component cannot price this flow -- a gas orifice asked to pass
        # more than sonic. If the gradient is forward, that *is* choking and
        # the pinned row is the honest equation. If it is not, the iterate is
        # simply wrong-signed and the row must stay invertible so Newton can
        # turn it round; the flow is priced just under the ceiling to get a
        # slope out of the component at all.
        #
        # This used to pin the row whenever the *flow guess* reached the
        # ceiling, gradient or no gradient. On a helium press manifold that
        # let a solenoid carry sonic flow *up* a 16 psi gradient into a tank
        # already above its regulator's setpoint -- converged, because a pinned
        # row does not know what downstream is doing -- and two such
        # sub-steps put 26 psi into a three-gram ullage. Repeated, the tank
        # ratcheted to 745 psig against a 550 psig regulator.
        if ceiling is not None and ceiling > 0.0 and available > 0.0:
            return choked_row()
        if ceiling is None or ceiling <= 0.0:
            raise
        clipped = math.copysign(0.999 * ceiling, mdot if mdot != 0.0 else 1.0)
        h = max(abs(clipped) * _FD_REL, _FD_ABS)
        hi = component.total_dp(clipped + h, conditions)
        lo = component.total_dp(clipped - h, conditions)
        slope = (hi - lo) / (2.0 * h)
        drop = component.total_dp(clipped, conditions)

    return _BranchRow(
        residual=available - drop,
        d_mdot=-slope,
        d_p_up=1.0,
        d_p_dn=-1.0,
    )


def _branch_rows(
    network: Network,
    x: np.ndarray,
    node_index: dict[str, int],
    branch_index: dict[str, int],
    signals: Mapping[str, float] | None = None,
) -> dict[str, _BranchRow]:
    rows: dict[str, _BranchRow] = {}
    for branch_id, row in branch_index.items():
        branch = network.branches[branch_id]
        rows[branch_id] = _branch_row(
            network,
            branch_id,
            float(x[row]),
            _pressure_at(network, x, node_index, branch.upstream),
            _pressure_at(network, x, node_index, branch.downstream),
            signals,
        )
    return rows


def _assemble_residual(
    network: Network,
    x: np.ndarray,
    node_index: dict[str, int],
    branch_index: dict[str, int],
    rows: dict[str, _BranchRow],
) -> np.ndarray:
    """Mass balances plus already-built branch rows. No component evaluation."""
    residual = np.zeros(len(x))

    for node_id, row in node_index.items():
        total = -network.nodes[node_id].demand
        for branch, sign in network.branches_at(node_id):
            if branch.id in branch_index:
                total += sign * x[branch_index[branch.id]]
        residual[row] = total

    for branch_id, row in branch_index.items():
        residual[row] = rows[branch_id].residual

    return residual


def _residuals(
    network: Network,
    x: np.ndarray,
    node_index: dict[str, int],
    branch_index: dict[str, int],
    signals: Mapping[str, float] | None = None,
) -> np.ndarray:
    """Residual from scratch. Used where the derivatives are not wanted."""
    residual = np.zeros(len(x))

    for node_id, row in node_index.items():
        total = -network.nodes[node_id].demand
        for branch, sign in network.branches_at(node_id):
            # Pruned stubs carry zero flow and contribute nothing to a balance.
            if branch.id in branch_index:
                total += sign * x[branch_index[branch.id]]
        residual[row] = total

    rows = _branch_rows(network, x, node_index, branch_index, signals)
    for branch_id, row in branch_index.items():
        residual[row] = rows[branch_id].residual

    return residual


def _incidence_pattern(
    network: Network, node_index: dict[str, int], branch_index: dict[str, int]
) -> tuple[list[int], list[int]]:
    """Row and column indices of every structurally non-zero Jacobian entry.

    Computed once. The sparsity of a hydraulic network never changes during a
    solve -- only the values in it do.
    """
    rows: list[int] = []
    cols: list[int] = []

    for node_id, row in node_index.items():
        for branch, _sign in network.branches_at(node_id):
            if branch.id not in branch_index:
                continue
            rows.append(row)
            cols.append(branch_index[branch.id])

    for branch_id, row in branch_index.items():
        branch = network.branches[branch_id]
        for end in (branch.upstream, branch.downstream):
            if end in node_index:
                rows.append(row)
                cols.append(node_index[end])
        rows.append(row)
        cols.append(row)

    return rows, cols


def _jacobian(
    network: Network,
    node_index: dict[str, int],
    branch_index: dict[str, int],
    branch_rows: dict[str, _BranchRow],
    rows: list[int],
    cols: list[int],
) -> csc_matrix:
    values: list[float] = []

    for node_id in node_index:
        for branch, sign in network.branches_at(node_id):
            if branch.id not in branch_index:
                continue
            values.append(float(sign))

    for branch_id in branch_index:
        branch = network.branches[branch_id]
        row = branch_rows[branch_id]
        for end, derivative in (
            (branch.upstream, row.d_p_up),
            (branch.downstream, row.d_p_dn),
        ):
            if end in node_index:
                values.append(derivative)
        slope = row.d_mdot
        if abs(slope) < MIN_BRANCH_SLOPE:
            slope = -MIN_BRANCH_SLOPE if slope <= 0.0 else MIN_BRANCH_SLOPE
        values.append(slope)

    n = len(node_index) + len(branch_index)
    return csc_matrix((values, (rows, cols)), shape=(n, n))


def _damped_update(
    network: Network,
    x: np.ndarray,
    step: np.ndarray,
    residual: np.ndarray,
    scale: np.ndarray,
    node_index: dict[str, int],
    branch_index: dict[str, int],
    signals: Mapping[str, float] | None = None,
    ignore: np.ndarray | None = None,
) -> np.ndarray:
    """Take the largest fraction of the Newton step that improves things.

    An undamped step from a crude guess routinely sends a pressure negative, at
    which point the property layer refuses -- correctly, but the solve should
    back off rather than fall over. Backtracking also handles the case where
    the step is simply too long, which quadratic losses make common.

    ``ignore`` must be the *same* mask the convergence test uses. Measuring
    improvement against a norm that includes a row nothing can improve makes
    every step look like a failure: the search backtracks to almost nothing,
    the iteration crawls, and the solve stops just above whatever tolerance was
    asked for -- tracking it exactly, which is the tell.
    """
    reference = _scaled_norm(residual, scale, ignore)
    fraction = 1.0

    for _ in range(20):
        trial = x + fraction * step
        if np.all(trial[: len(node_index)] > 0.0):
            try:
                trial_residual = _residuals(
                    network, trial, node_index, branch_index, signals
                )
            except Exception:
                trial_residual = None
            if trial_residual is not None:
                if _scaled_norm(trial_residual, scale, ignore) < reference:
                    return trial
        fraction *= 0.5

    # Nothing improved. Take a small step anyway rather than stalling; the
    # iteration cap is what ultimately stops a solve that is going nowhere.
    #
    # Clamped to keep every pressure positive, which the backtracking above
    # already does and this used to skip. An unclamped last-resort step is rare
    # and, when it fires, catastrophic: it lands a node below absolute zero, the
    # property layer refuses on the *next* iteration, and the exception escapes
    # a solve the caller asked not to raise. A near-vacuum boundary -- a tank
    # sitting at atmosphere while a 4500 psi bottle is opened onto it -- hits it
    # every time.
    trial = x + 0.01 * step
    pressures = trial[: len(node_index)]
    floor = np.maximum(x[: len(node_index)] * 0.01, 1.0)
    trial[: len(node_index)] = np.where(pressures > 0.0, pressures, floor)
    return trial


def _result(
    network: Network,
    x: np.ndarray,
    converged: bool,
    iterations: int,
    norm: float,
    started: float,
    stubs: list[DeadEnd],
    isolated: set[str],
) -> SteadyResult:
    """Package a solution vector as a result.

    ``isolated`` is not optional and must be the same set the solve used. This
    function rebuilds the branch ordering to read ``x`` back, and that ordering
    is ``[b for b in branches if b not in stubs | isolated]`` -- so a caller
    that omits it gets a *longer* list than the vector it is indexing into.
    The failure is an IndexError on a good day and silently misattributed flows
    on a bad one, where every branch after the first isolated valve reports its
    neighbour's flow. It defaulted to empty until the convergence-failure path,
    which is the one place that omitted it, started raising on a stand with a
    shut valve on it.
    """
    from feedtwin import stack_versions

    stub_nodes = {d.node for d in stubs}
    stub_branches = {d.branch for d in stubs} | isolated
    free = [n for n in network.free_nodes if n not in stub_nodes]
    solved = [b for b in network.branches if b not in stub_branches]

    node_index = {n: i for i, n in enumerate(free)}
    branch_index = {b: len(free) + i for i, b in enumerate(solved)}

    pressures = {
        node_id: _pressure_at(network, x, node_index, node_id)
        for node_id in network.nodes
        if node_id not in stub_nodes
    }
    flows = {b: float(x[i]) for b, i in branch_index.items()}
    # A shut valve passes nothing. Stated here rather than left to the
    # back-fill, because an isolated branch is not always a stub -- both its
    # ends can be live parts of the network with no path between them.
    for branch_id in isolated:
        flows[branch_id] = 0.0

    # Back-fill the stubs. Zero flow, so the only pressure change across one is
    # its static head.
    #
    # Repeated passes rather than one reversed sweep. Peeling is outermost-first
    # for the ordinary degree-one case, but a node cut off entirely by a shut
    # valve is found in a later pass and can be the live end of something found
    # earlier -- so the single ordering that used to work no longer exists.
    # Looping until nothing more can be filled is order-independent and stops
    # in as many passes as the longest chain.
    indeterminate: list[str] = []
    indeterminate_nodes: list[str] = []
    pending = list(stubs)
    while pending:
        progressed = False
        deferred: list[DeadEnd] = []
        for dead in pending:
            live_p = pressures.get(dead.live_end)
            if live_p is None:
                deferred.append(dead)
                continue
            if live_p <= 0.0:
                # The live end is not at a pressure, so there is no fluid state
                # to ask about and nothing sensible to hang off it. This is only
                # reachable while building the *result of a failed solve* --
                # `converged` is already False by the time we get here -- and
                # the failure should surface as "did not converge", not as
                # CoolProp objecting to -6428 bar several frames away from the
                # branch that caused it.
                pressures[dead.node] = live_p
                flows[dead.branch] = 0.0
                progressed = True
                continue
            branch = network.branches[dead.branch]
            conditions = network.conditions(dead.live_end, live_p)
            head = branch.component.static_head(conditions)
            pressures[dead.node] = (
                live_p - head if branch.upstream == dead.live_end else live_p + head
            )
            flows[dead.branch] = 0.0
            # A component that still holds a drop at zero flow -- a check valve
            # behind its cracking pressure -- leaves the stub genuinely
            # undefined. Report the live end's pressure and say it is an upper
            # bound.
            if (
                branch.component.pressure_drop(0.0, conditions) > 0.0
                or dead.live_end in indeterminate_nodes
            ):
                # Undefined-ness travels. A regulator with nothing drawing
                # through it leaves its outlet undefined; the manifold that
                # outlet feeds is then no better known, and reporting *it* as
                # solved put bottle pressure on a transducer tagged for the
                # regulated line. Stubs are filled in dependency order, so
                # checking the live end here is enough to carry it along.
                indeterminate.append(dead.branch)
                indeterminate_nodes.append(dead.node)
            progressed = True
        if not progressed:
            # A closed loop of stubs, which cannot happen for a drawn system but
            # would spin here forever if it did. Give them the reference
            # pressure and mark them undefined rather than hang.
            for dead in deferred:
                pressures.setdefault(dead.node, 101325.0)
                flows[dead.branch] = 0.0
                indeterminate.append(dead.branch)
                indeterminate_nodes.append(dead.node)
            break
        pending = deferred

    mass_residuals: dict[str, float] = {}
    for node_id in free:
        total = -network.nodes[node_id].demand
        for branch, sign in network.branches_at(node_id):
            total += sign * flows.get(branch.id, 0.0)
        mass_residuals[node_id] = total

    diagnostics: dict[str, dict[str, float]] = {}
    regularised: list[str] = []
    choked: list[str] = []
    branch_rows = _branch_rows(network, x, node_index, branch_index)
    for branch_id, branch in network.branches.items():
        conditions = network.conditions(
            branch.upstream, pressures.get(branch.upstream, 0.0) or 1.0e5
        )
        try:
            diagnostics[branch_id] = branch.component.diagnostics(
                flows[branch_id], conditions
            )
        except Exception:
            diagnostics[branch_id] = {}
        if branch_id in branch_index:
            row = branch_rows[branch_id]
            if row.choked:
                choked.append(branch_id)
            elif abs(row.d_mdot) < MIN_BRANCH_SLOPE:
                regularised.append(branch_id)

    return SteadyResult(
        pressures=pressures,
        flows=flows,
        converged=converged,
        iterations=iterations,
        residual_norm=norm,
        mass_residuals=mass_residuals,
        dead_ends=sorted(stub_branches),
        indeterminate_dead_ends=sorted(indeterminate),
        indeterminate_nodes=sorted(indeterminate_nodes),
        diagnostics=diagnostics,
        violations=network.check(),
        regularised_branches=sorted(regularised),
        elapsed=time.perf_counter() - started,
        stack=stack_versions(),
    )
