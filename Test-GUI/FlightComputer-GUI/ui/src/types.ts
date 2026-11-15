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

export interface SelfTestSummary {
  /** Every chip passed: the only time the button is green. */
  ok: boolean;
  label: string;
  /** One line per chip that did not pass. */
  detail: string;
  /** Names (as in self_test) of the chips that did not pass. */
  failed: string[];
}

export interface StatusView {
  sections: { title: string; rows: Row[] }[];
  self_test: Row[];
  self_test_summary: SelfTestSummary;
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
  /** SELF_TEST and IDLE: the Idle heartbeats, newest first. */
  heartbeats: HeartbeatRow[] | null;
  show_graphs: boolean;
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
  can_check: boolean;
  card: number;
  cards: string[];
  card_check: string;
}

export interface View {
  ports: { dev: string; label: string }[];
  port: string;
  link: { open: boolean; ready: boolean; text: string; heartbeat_lost: boolean };
  state: [string, Tone] | null;
  notices: Notice[];
  status: StatusView;
  stages: Stage[];
  live: LiveView;
  config: ConfigView;
  flights: FlightsView;
  ground: GroundView;
  recording: RecordingView;
}

export interface RecordingView {
  phase: "waiting" | "recording" | "stopped";
  text: string;
  can_stop: boolean;
  can_save: boolean;
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
  | { cmd: "recording_stop" }
  | { cmd: "flight_open"; session: number }
  | { cmd: "flight_reveal"; session: number | null }
  | { cmd: "flight_wipe"; confirm: string }
  | { cmd: "flight_check_card" }
  | { cmd: "flight_card"; card: number }
  | { cmd: "dismiss_notice" }
  | { cmd: "ground_arm" }
  | { cmd: "ground_unarm" }
  | { cmd: "ground_station_from_fix" }
  | { cmd: "ground_station_set"; text: string }
  | { cmd: "ground_station_clear" }
  | { cmd: "self_test" };

/** Native file dialogs (Rust side); the chosen path goes straight to the backend. */
export type Pick = "config_import" | "config_export" | "flight_folder" | "flight_csv";

/** A box of current values on the Live tab (see live.rs `Reading`). */
export interface Reading {
  label: string;
  values: [string, string][];
  unit: string;
  stale: boolean;
}

/** A flight stage on the Live tab's side panel (see stages.rs). */
/** One Idle heartbeat on the Live tab (see heartbeats.rs). */
export interface HeartbeatRow {
  n: number;
  uptime: string;
  battery: string;
  battery_state: [string, Tone] | null;
  chips: string;
  radio: [string, Tone] | null;
}

export interface Stage {
  name: string;
  does: string;
  status: "done" | "current" | "next" | "later";
  how: string | null;
}

/** The Ground tab: a receiver board's view of the rocket (see ground.rs). */
export interface GroundView {
  show: boolean;
  rocket: [string, Tone] | null;
  heard: string;
  heard_stale: boolean;
  signal: string;
  battery: string;
  adc: { name: string; counts: number; pin_v: string; value: string }[];
  chips: { name: string; result: [string, Tone]; value: string; expected: string; words: string; when: string }[];
  telemetry: string;
  place: string;
  where_note: string;
  track: [number, number][];
  gps: GpsView;
  log: { t: string; kind: string; seq: number; rssi: string; summary: string }[];
  command: string;
  busy: boolean;
}

/** The GPS card (ground.rs GpsView). Course is direction of travel from
 * successive fixes; tilt is from the accelerometer; there is no compass heading. */
export interface GpsView {
  has_fix: boolean;
  fix: [string, Tone];
  sats: string;
  lat: string;
  lon: string;
  alt: string;
  age: string;
  age_stale: boolean;
  course_deg: number | null;
  course: string;
  speed: string;
  vspeed: string;
  tilt_deg: number | null;
  tilt: string;
  tilt_note: string;
  station_set: boolean;
  station: string;
  station_error: string;
  bearing_deg: number | null;
  range: string;
  elevation: string;
  station_en: [number, number] | null;
}
