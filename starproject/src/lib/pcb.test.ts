import { describe, expect, it } from "vitest";

import { type BoardTask, isOverdue, toRowData, type WorkspaceTask } from "@/lib/board";
import { dayOf, toTimeline } from "@/lib/gantt";
import {
  PCB_FIELD_LABEL,
  PCB_STAGES,
  type PcbStageKey,
  type PcbStageLite,
  type PcbStageState,
  currentStage,
  currentStageOverdue,
  derivedDueDate,
  dueFollowsStages,
  parseAltiumUrl,
  stageAssignees,
  stageMarks,
  stageSummary,
} from "@/lib/pcb";

const ryan = { id: "u1", name: "Ryan H", email: "r@berkeley.edu", displayName: null };
const kody = { id: "u2", name: "Kody N", email: "k@berkeley.edu", displayName: null };
const rohith = { id: "u3", name: "Rohith C", email: "c@berkeley.edu", displayName: null };

const d = (ymd: string) => new Date(`${ymd}T00:00:00Z`);

/** Six stages, open and empty, with `over` applied by key. */
function stages(
  over: Partial<Record<PcbStageKey, Partial<PcbStageLite>>> = {},
): PcbStageLite[] {
  return PCB_STAGES.map((stage) => ({
    stage,
    status: "open" as PcbStageState,
    dueDate: null,
    assignees: [],
    ...over[stage],
  }));
}

function board(over: Partial<BoardTask> = {}, st: PcbStageLite[] = stages()): BoardTask {
  return {
    id: "t1",
    title: "Prop Board",
    status: "in_progress",
    projectId: "p",
    assignees: [],
    startDate: null,
    dueDate: null,
    blockedBy: [],
    pcb: { altiumUrl: null, stages: st },
    ...over,
  } as unknown as BoardTask;
}

describe("currentStage", () => {
  it("is the first open stage in board order, whatever order they load in", () => {
    const st = stages({ components: { status: "done" }, schematic: { status: "skipped" } });
    expect(currentStage([...st].reverse())?.stage).toBe("layout");
  });

  it("is null once every stage is done or skipped", () => {
    const all = stages(
      Object.fromEntries(PCB_STAGES.map((s, i) => [s, { status: i % 2 ? "done" : "skipped" }])),
    );
    expect(currentStage(all)).toBeNull();
    expect(stageSummary({ stages: all })).toBe("All stages done");
  });
});

describe("derivedDueDate", () => {
  it("is the latest dated stage, not the last stage in order", () => {
    const st = stages({
      layout: { dueDate: d("2026-11-25") },
      review: { dueDate: d("2026-11-20") }, // slipped behind layout: no cascade
    });
    expect(derivedDueDate(st)?.toISOString().slice(0, 10)).toBe("2026-11-25");
  });

  it("ignores skipped stages, and is null with nothing dated", () => {
    const st = stages({
      layout: { dueDate: d("2026-11-25") },
      bringup: { dueDate: d("2026-12-20"), status: "skipped" },
    });
    expect(derivedDueDate(st)?.toISOString().slice(0, 10)).toBe("2026-11-25");
    expect(derivedDueDate(stages())).toBeNull();
    expect(dueFollowsStages(stages())).toBe(false);
    expect(dueFollowsStages(st)).toBe(true);
  });

  it("counts done stages: their dates are still the plan", () => {
    const st = stages({ bringup: { dueDate: d("2026-12-20"), status: "done" } });
    expect(derivedDueDate(st)?.toISOString().slice(0, 10)).toBe("2026-12-20");
  });
});

describe("stageAssignees", () => {
  it("is everyone on any stage, once each, in stage order", () => {
    const st = stages({
      solder: { assignees: [rohith] },
      layout: { assignees: [ryan, kody] },
      review: { assignees: [kody] },
    });
    expect(stageAssignees(st).map((a) => a.id)).toEqual(["u1", "u2", "u3"]);
  });
});

describe("overdue", () => {
  const today = dayOf(d("2026-11-20"));

  it("follows the current stage, not the board's last date", () => {
    const st = stages({
      components: { status: "done", dueDate: d("2026-11-01") },
      schematic: { status: "done" },
      layout: { dueDate: d("2026-11-18") },
      bringup: { dueDate: d("2026-12-20") },
    });
    expect(currentStageOverdue({ stages: st }, "in_progress", today)).toBe(true);
    // An undated open stage ahead of it is the current one, and isn't late.
    const undated = st.map((s) => (s.stage === "schematic" ? { ...s, status: "open" as const } : s));
    expect(currentStageOverdue({ stages: undated }, "in_progress", today)).toBe(false);
    // The task's own due date (Dec 20) is fine; the board is still late.
    const t = board({ dueDate: d("2026-12-20") }, st);
    expect(isOverdue(t, d("2026-11-20"))).toBe(true);
  });

  it("is never overdue once the task is done, or when the late stage is done", () => {
    const late = stages({ layout: { dueDate: d("2026-11-18") } });
    expect(currentStageOverdue({ stages: late }, "done", today)).toBe(false);
    const finished = stages({ layout: { dueDate: d("2026-11-18"), status: "done" } });
    expect(currentStageOverdue({ stages: finished }, "in_progress", today)).toBe(false);
  });

  it("puts the current stage on the list row", () => {
    const st = stages({ layout: { dueDate: d("2026-11-25"), assignees: [ryan] } });
    const row = toRowData({
      ...board({}, st),
      projectName: "LE4",
      subteamName: "",
      assigneeName: "",
    } as WorkspaceTask);
    expect(row.pcbStage).toEqual({ label: "Components", due: "" });
    const st2 = stages({ components: { status: "done" }, schematic: { status: "done" }, layout: st[2] });
    const row2 = toRowData({ ...board({}, st2), projectName: "", subteamName: "", assigneeName: "" } as WorkspaceTask);
    expect(row2.pcbStage).toEqual({ label: "Layout", due: "2026-11-25" });
  });
});

describe("stageMarks", () => {
  it("lists dated, unskipped stages in order and flags one due before an earlier stage", () => {
    const st = stages({
      schematic: { dueDate: d("2026-11-10") },
      layout: { dueDate: d("2026-11-25") },
      review: { dueDate: d("2026-11-22") },
      solder: { dueDate: d("2026-11-30"), status: "skipped" },
    });
    const marks = stageMarks(st, (a) => a.id);
    expect(marks.map((m) => [m.stage, m.outOfOrder])).toEqual([
      ["schematic", false],
      ["layout", false],
      ["review", true],
    ]);
  });
});

describe("toTimeline on a PCB board", () => {
  it("spans the stage dates with no start date set, and carries the marks", () => {
    const st = stages({
      schematic: { dueDate: d("2026-11-10") },
      layout: { dueDate: d("2026-11-25") },
    });
    const [item] = toTimeline([board({ dueDate: d("2026-11-25") }, st)], dayOf(d("2026-11-01"))).groups[0]
      .items;
    expect(item.start).toBe(dayOf(d("2026-11-10")));
    expect(item.end).toBe(dayOf(d("2026-11-25")));
    expect(item.dueOnly).toBe(false);
    expect(item.stages?.map((m) => m.stage)).toEqual(["schematic", "layout"]);
  });

  it("starts at the task's start date when it has one", () => {
    const st = stages({ layout: { dueDate: d("2026-11-25") }, review: { dueDate: d("2026-11-28") } });
    const [item] = toTimeline([board({ startDate: d("2026-11-01"), dueDate: d("2026-11-28") }, st)]).groups[0]
      .items;
    expect(item.start).toBe(dayOf(d("2026-11-01")));
    expect(item.end).toBe(dayOf(d("2026-11-28")));
  });

  it("places a board dated only by its stages, not as unscheduled", () => {
    const st = stages({ layout: { dueDate: d("2026-11-25") }, review: { dueDate: d("2026-11-28") } });
    const { groups, unscheduled } = toTimeline([board({}, st)]);
    expect(groups[0].items).toHaveLength(1);
    expect(unscheduled).toHaveLength(0);
  });

  it("leaves an undated board unscheduled", () => {
    expect(toTimeline([board()]).unscheduled).toHaveLength(1);
  });
});

describe("parseAltiumUrl", () => {
  it("takes an https link, clears on blank and refuses anything else", () => {
    expect(parseAltiumUrl(" https://star.365.altium.com/designs/X ")).toBe(
      "https://star.365.altium.com/designs/X",
    );
    expect(parseAltiumUrl("  ")).toBeNull();
    expect(() => parseAltiumUrl("star.365.altium.com")).toThrow(/https/);
    expect(() => parseAltiumUrl("javascript:alert(1)")).toThrow(/https/);
  });
});

describe("PCB_FIELD_LABEL", () => {
  it("names every stage field History can log", () => {
    for (const s of PCB_STAGES)
      for (const w of ["due", "status", "assignees"])
        expect(PCB_FIELD_LABEL[`pcb.${s}.${w}`], `${s}.${w}`).toBeTruthy();
  });
});
