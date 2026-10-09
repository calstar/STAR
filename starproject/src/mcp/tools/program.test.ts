import { describe, expect, it } from "vitest";

import { DEFAULT_PHASES } from "@/lib/program";

import {
  isCalendarDay,
  serialiseMilestone,
  serialiseProjectProgram,
  serialiseSubteamPhase,
  type MilestoneRow,
  type ProjectProgramRow,
} from "./program";

const avionics = { id: "s-av", name: "Avionics", color: "#00f" };
const structures = { id: "s-st", name: "Structures", color: null };

const milestone = (over: Partial<MilestoneRow> = {}): MilestoneRow => ({
  id: "m1",
  title: "CDR",
  dueDate: new Date("2026-11-03T00:00:00Z"),
  done: false,
  url: null,
  subteam: null,
  ...over,
});

const project = (over: Partial<ProjectProgramRow> = {}): ProjectProgramRow => ({
  id: "p1",
  name: "LE4",
  parentId: null,
  featured: true,
  trackOrder: 2,
  phases: [],
  phaseStatuses: [],
  milestones: [],
  ...over,
});

describe("serialiseMilestone", () => {
  it("sends the due day as YYYY-MM-DD and keeps the subteam", () => {
    expect(serialiseMilestone(milestone({ subteam: avionics, url: "https://x.y/" }))).toEqual({
      id: "m1",
      title: "CDR",
      dueDate: "2026-11-03",
      done: false,
      url: "https://x.y/",
      subteam: avionics,
    });
  });
});

describe("serialiseSubteamPhase", () => {
  const phases = ["Design", "Build", "Test"];

  it("labels the phase by index", () => {
    expect(serialiseSubteamPhase({ phase: 1, subteam: avionics }, phases)).toEqual({
      subteam: avionics,
      phase: 1,
      phaseLabel: "Build",
      done: false,
    });
  });

  it("phases.length is done", () => {
    const row = serialiseSubteamPhase({ phase: 3, subteam: avionics }, phases);
    expect(row.done).toBe(true);
    expect(row.phase).toBe(3);
    expect(row.phaseLabel).toBe("Done");
  });

  it("clamps a stale index the way the board does", () => {
    // The list was shortened after the subteam was set past its new end.
    expect(serialiseSubteamPhase({ phase: 9, subteam: avionics }, phases)).toMatchObject({ phase: 3, done: true });
    expect(serialiseSubteamPhase({ phase: -2, subteam: avionics }, phases)).toMatchObject({
      phase: 0,
      phaseLabel: "Design",
      done: false,
    });
  });
});

describe("serialiseProjectProgram", () => {
  it("uses the default phases when none are set, and the project's own when they are", () => {
    expect(serialiseProjectProgram(project()).phases).toEqual(DEFAULT_PHASES);
    expect(serialiseProjectProgram(project({ phases: ["A", "B"] })).phases).toEqual(["A", "B"]);
  });

  it("lists subteams by name and milestones by due date", () => {
    const out = serialiseProjectProgram(
      project({
        phases: ["A", "B"],
        phaseStatuses: [
          { phase: 2, subteam: structures },
          { phase: 0, subteam: avionics },
        ],
        milestones: [
          milestone({ id: "late", dueDate: new Date("2026-12-01T00:00:00Z") }),
          milestone({ id: "soon", dueDate: new Date("2026-10-15T00:00:00Z"), subteam: avionics }),
        ],
      }),
    );
    expect(out.subteams.map((s) => s.subteam.name)).toEqual(["Avionics", "Structures"]);
    expect(out.subteams.map((s) => s.done)).toEqual([false, true]);
    expect(out.milestones.map((m) => m.id)).toEqual(["soon", "late"]);
    expect(out.milestones[0].dueDate).toBe("2026-10-15");
    expect(out.milestones[0].subteam).toEqual(avionics);
  });

  it("carries the card fields through", () => {
    expect(serialiseProjectProgram(project({ featured: false, trackOrder: 0, parentId: "p0" }))).toMatchObject({
      id: "p1",
      name: "LE4",
      parentId: "p0",
      featured: false,
      trackOrder: 0,
    });
  });
});

describe("isCalendarDay", () => {
  it("accepts only a day that round-trips", () => {
    expect(isCalendarDay("2026-11-03")).toBe(true);
    expect(isCalendarDay("2028-02-29")).toBe(true);
    // JS would roll these forward instead of rejecting them.
    expect(isCalendarDay("2026-02-31")).toBe(false);
    expect(isCalendarDay("2027-02-29")).toBe(false);
    expect(isCalendarDay("2026-13-01")).toBe(false);
    expect(isCalendarDay("nonsense")).toBe(false);
  });
});
