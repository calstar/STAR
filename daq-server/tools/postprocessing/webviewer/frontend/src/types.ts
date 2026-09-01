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
