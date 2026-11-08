// The backend's view and commands, as they arrive over IPC. Mirrors the Rust
// structs in src/backend (serde's JSON shapes: tuples are arrays, enums are
// snake_case strings). Nothing here is computed: the window renders these.

export type Tone = "neutral" | "good" | "warn" | "bad" | "info";

export interface Notice {
  title: string;
  text: string;
}

export interface Row {
  name: string;
  value: string;
  chip: Tone | null;
  hint: string | null;
}

export interface StatusView {
  sections: { title: string; rows: Row[] }[];
  self_test: Row[];
  messages: string[];
}

export interface PlotSpec {
  title: string;
  unit: string;
  series: string[];
}

export interface LiveView {
  rate: number;
  rates: { value: number; label: string }[];
  mask: number;
  sensors: [number, string][];
  error: string | null;
  plots: PlotSpec[];
  window_s: number;
}

export interface Opt {
  value: number;
  label: string;
}

export interface FieldView {
  key: string;
  label: string;
  kind: "select" | "number" | "mask";
  value: number;
  text: string;
  unit: string;
  options: Opt[];
  help: string;
  board: string | null;
  differs: boolean;
  error: string | null;
}

export interface ConfigView {
  groups: { title: string; fields: FieldView[] }[];
  banner: string;
  banner_tone: Tone | null;
  link: [string, string][];
  issues: string[];
  notes: string[];
  can_read: boolean;
  can_write: boolean;
  can_revert: boolean;
}

export interface EntryView {
  session: number;
  name: string;
  started: string;
  length: string;
  size: string;
  downloaded: boolean;
}

export interface FlightsView {
  summary: string;
  entries: EntryView[];
  busy: boolean;
  can_refresh: boolean;
  can_download: boolean;
  can_wipe: boolean;
  progress: { fraction: number; text: string } | null;
  wipe_warning: string;
  wipe_word: string;
  shown: { plot_id: number; detail: string; warnings: [string, Tone][]; folder: string } | null;
  root: string;
}

export interface View {
  ports: { dev: string; label: string }[];
  port: string;
  link: { open: boolean; ready: boolean; text: string; heartbeat_lost: boolean };
  state: [string, Tone] | null;
  notices: Notice[];
  status: StatusView;
  live: LiveView;
  config: ConfigView;
  flights: FlightsView;
}

/** The `live` event: samples since the last one. `y` has a value per line of chart `plot`. */
export interface Batch {
  points: { plot: number; t: number; y: (number | null)[] }[];
  session: number;
  readings: Reading[];
}

export interface FlightPlot {
  id: number;
  charts: { title: string; unit: string; lines: { name: string; x: number[]; y: number[] }[] }[];
  events: [number, string][];
  x_label: string;
}

export type Command =
  | { cmd: "rescan" }
  | { cmd: "select_port"; port: string }
  | { cmd: "connect" }
  | { cmd: "disconnect" }
  | { cmd: "set_stream"; rate: number; mask: number }
  | { cmd: "config_edit"; key: string; text: string }
  | { cmd: "config_toggle"; key: string; bit: number }
  | { cmd: "config_read" }
  | { cmd: "config_apply" }
  | { cmd: "config_save" }
  | { cmd: "config_revert" }
  | { cmd: "config_defaults" }
  | { cmd: "flights_refresh" }
  | { cmd: "flight_download"; session: number }
  | { cmd: "flight_cancel" }
  | { cmd: "flight_open"; session: number }
  | { cmd: "flight_reveal"; session: number | null }
  | { cmd: "flight_wipe"; confirm: string }
  | { cmd: "dismiss_notice" };

/** Native file dialogs (Rust side); the chosen path goes straight to the backend. */
export type Pick = "config_import" | "config_export" | "flight_folder";

/** A box of current values on the Live tab (see live.rs `Reading`). */
export interface Reading {
  label: string;
  values: [string, string][];
  unit: string;
  stale: boolean;
}
