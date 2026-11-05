"""A live session's whole trace as the CSV the Plots tab downloads.

Used to be built in the browser (views/Plots.tsx ``downloadCsv``), so only an open
cockpit could produce it. Now the backend writes it
(GET /api/session/{id}/history.csv) and the button fetches that, so an agent
through the design-tools MCP gets the same file. The format is unchanged:

    t_s,state,<name> [<unit>],...

- a channel's name is the stand's alias for it (the hookup's names), else its tag;
- pressures go out in psia, as their header says, to 3 places (the wire is psig
  hundredths); every other number as JavaScript prints it;
- ``state`` is the state machine's state at each sample, walked from the
  transitions (an event matches the sample it was rounded from); before the
  first transition it is blank, and with none recorded it is the stand's
  current state;
- a thermocouple the twin cannot read (all 0 K on the wire) is an empty column.
Numbers are printed by stardesign.jsformat so the file is byte-for-byte what the
browser wrote.
"""

from __future__ import annotations

from typing import Any, Mapping

from stardesign.jsformat import js_number, js_to_fixed

#: frontend/src/lib/pressure.ts: PSI_PA and ATMOSPHERE_PSI.
PSI_PA = 6894.757293168361
ATMOSPHERE_PSI = 101325 / PSI_PA
GAUGE = "psig"
PRESSURE_UNIT = "psia"


def is_pressure(unit: str | None) -> bool:
    return (unit or GAUGE) == GAUGE


def shown_unit(unit: str | None) -> str:
    return PRESSURE_UNIT if is_pressure(unit) else (unit or "")


#: How far a state change's time on the wire can sit from the sample it
#: happened at [s]: /history rounds an event to the millisecond and keeps a
#: sample's time whole, so the first Fire sample at 0.7577 s came with its
#: event at 0.758 and was labelled Ready.
EVENT_ROUNDING_S = 0.0005


def unread(channel: Mapping[str, Any]) -> bool:
    """A temperature channel the twin has nothing to read for: the node its
    thermocouple sits on carries no temperature and the wire sends 0 K, which
    no sensor reads. Its column is left empty, never written as 0 K."""
    values = channel.get("values") or []
    return (
        not is_pressure(channel.get("unit"))
        and channel.get("unit") == "K"
        and all(not (v is not None and v > 0) for v in values)
    )


def _quote(v: str) -> str:
    return '"' + v.replace('"', '""') + '"' if any(ch in v for ch in '",\n') else v


def history_csv(
    history: Mapping[str, Any], aliases: Mapping[str, str], state_now: str
) -> str:
    """``history`` is the /history response (RunOut as a dict) at full rate."""
    channels = history.get("channels") or []
    blind = [unread(c) for c in channels]
    events = history.get("events") or []
    at = 0
    state = "" if events else state_now
    header = ["t_s", "state"] + [
        f"{aliases.get(c['id']) or c['tag']} [{shown_unit(c.get('unit'))}]"
        for c in channels
    ]
    lines = [",".join(_quote(h) for h in header)]
    for i, t in enumerate(history.get("times_s") or []):
        while at < len(events) and events[at]["t"] <= t + EVENT_ROUNDING_S:
            state = events[at]["label"]
            at += 1
        cells = [js_to_fixed(t, 3), _quote(state)]
        for c, dark in zip(channels, blind):
            values = c.get("values") or []
            v = values[i] if i < len(values) else None
            if v is None or dark:
                cells.append("")
            elif is_pressure(c.get("unit")):
                cells.append(js_to_fixed(v + ATMOSPHERE_PSI, 3))
            else:
                cells.append(js_number(v))
        lines.append(",".join(cells))
    return "\n".join(lines)
