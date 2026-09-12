"""A solved network, written out so a person can read it.

The pressure ladder is the answer to the question that started this project:
where does the pressure actually go between the tank and the injector. It lists
every component in flow order with what it cost, so the largest loss is
obvious rather than inferred.

Two things are always printed, whether or not anyone asked:

* **Mass conservation.** A converged solve that does not conserve mass has
  found the wrong answer confidently, and that is exactly the failure that
  looks like success.
* **Assumed parameters and violated limits.** A number resting on twelve
  library defaults is a different claim from one resting on twelve
  measurements, and the difference should never be invisible.
"""

from __future__ import annotations

from feedtwin.solve.network import Network
from feedtwin.solve.steady import SteadyResult

_BAR = 1.0e5


def pressure_ladder(network: Network, result: SteadyResult) -> str:
    """A text report of where the pressure went."""
    lines: list[str] = []
    status = "converged" if result.converged else "DID NOT CONVERGE"
    lines.append(
        f"Steady solve: {status} in {result.iterations} iterations "
        f"({result.elapsed * 1e3:.1f} ms)"
    )
    lines.append("")

    lines.append(
        f"{'branch':<14} {'from':<10} {'to':<10} "
        f"{'mdot':>10} {'dp':>10} {'p_out':>10}"
    )
    lines.append(f"{'':14} {'':10} {'':10} {'kg/s':>10} {'bar':>10} {'bar':>10}")
    lines.append("-" * 68)

    ordered = sorted(
        network.branches.values(),
        key=lambda b: -result.pressures[b.upstream],
    )
    for branch in ordered:
        dp = result.dp(branch.id, network)
        lines.append(
            f"{branch.id:<14} {branch.upstream:<10} {branch.downstream:<10} "
            f"{result.flows[branch.id]:>10.4f} {dp / _BAR:>10.4f} "
            f"{result.pressures[branch.downstream] / _BAR:>10.4f}"
        )

    lines.append("")
    lines.append(
        f"mass conservation: worst node imbalance "
        f"{result.max_mass_residual:.3e} kg/s"
    )

    if result.regularised_branches:
        lines.append(
            "derivative floor active at convergence on: "
            + ", ".join(result.regularised_branches)
            + "  (branches carrying essentially no flow)"
        )

    assumed = sorted(
        {
            name
            for branch in network.branches.values()
            for name in branch.component.instance.assumptions()
        }
    )
    if assumed:
        lines.append(f"resting on library defaults: {', '.join(assumed)}")

    for violation in result.violations:
        lines.append(str(violation))

    return "\n".join(lines)
