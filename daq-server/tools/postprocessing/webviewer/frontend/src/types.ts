export interface Run {
  id: string;
  name: string;
  started: string;
  cached: boolean;
  /** Written by a sim session (daq_sim_… prefix), not the real test stand. */
  simulated: boolean;
}

export interface Component {
  name: string;
  entity: string;
  field: string;
  family: string;
  unit: string;
  discrete: boolean;
  primary: boolean;
  /**
   * What this channel actually is, from the run's config snapshot: "Ox Upstream",
   * "LOX Main". Empty when the run has no snapshot, or when config does not name
   * that entity: then the numeric identity is all there is.
   */
  label: string;
  t_min?: number;
  t_max?: number;
}

export interface RunIndex {
  run_id: string;
  t_min: number | null;
  t_max: number | null;
  duration_s: number | null;
  n_components: number;
  size_bytes: number | null;
  components: Component[];
  /** A config snapshot was found beside this run's DB, so entity labels are its own. */
  has_config: boolean;
  /** State id -> name, keyed as strings (JSON). Built-in table, overridden by the snapshot. */
  states: Record<string, string>;
  /** Fields whose value is a state id, so the chart can name it instead of plotting a bare u8. */
  state_fields: string[];
}

export interface Series {
  name: string;
  discrete: boolean;
  n: number;
  t: number[];
  v: (number | null)[];
}

export interface SeriesResponse {
  run_id: string;
  series: Series[];
}

/** How one plotted series should be labelled: resolved by App from the run index and
 *  the names toggle, so Chart never has to know where a name came from. */
export interface SeriesMeta {
  /** Display name for the line: the config role, or the Elodin entity. */
  label: string;
  unit: string;
  field: string;
  /** State id -> name, for the fields whose value IS a state. null for everything else. */
  valueNames: Record<string, string> | null;
}
