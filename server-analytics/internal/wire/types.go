// Package wire is the batch an agent pushes to the hub. Both sides import it, so
// the schema cannot drift between them.
package wire

// Batch is one push: everything an agent sampled since its last successful one.
// Timestamps are unix milliseconds.
type Batch struct {
	Host       string            `json:"host"`
	Samples    []HostSample      `json:"samples"`
	Containers []ContainerSample `json:"containers"`
	Logs       []LogLine         `json:"logs"`
	Deploy     *Deploy           `json:"deploy,omitempty"`
}

type HostSample struct {
	TS        int64   `json:"ts"`
	CPU       float64 `json:"cpu"` // percent of all cores, 0-100
	Cores     int     `json:"cores"`
	MemUsed   uint64  `json:"mem_used"` // bytes; MemTotal - MemAvailable
	MemTotal  uint64  `json:"mem_total"`
	SwapUsed  uint64  `json:"swap_used"`
	SwapTotal uint64  `json:"swap_total"`
	Load1     float64 `json:"load1"`
	Load5     float64 `json:"load5"`
	Load15    float64 `json:"load15"`
	DiskUsed  uint64  `json:"disk_used"`
	DiskTotal uint64  `json:"disk_total"`
	NetRx     float64 `json:"net_rx"` // bytes/s, all non-loopback interfaces
	NetTx     float64 `json:"net_tx"`
	Uptime    float64 `json:"uptime"` // seconds since host boot
	// The highest CPU and memory the agent's one-second peek saw since the last
	// sample, so a spike shorter than SAMPLE_INTERVAL is still recorded. Zero
	// from an agent that predates them; the hub then falls back to CPU/MemUsed.
	CPUMax float64 `json:"cpu_max,omitempty"`
	MemMax uint64  `json:"mem_max,omitempty"`
}

type ContainerSample struct {
	TS       int64   `json:"ts"`
	Name     string  `json:"name"`
	Image    string  `json:"image"`
	State    string  `json:"state"`  // running, exited, restarting, ...
	Health   string  `json:"health"` // healthy, unhealthy, starting, or "" without a healthcheck
	Restarts int     `json:"restarts"`
	CPU      float64 `json:"cpu"` // percent of one core, as `docker stats` reports it
	MemUsed  uint64  `json:"mem_used"`
	MemLimit uint64  `json:"mem_limit"`         // 0 when unlimited
	CPUMax   float64 `json:"cpu_max,omitempty"` // as HostSample.CPUMax
	MemMax   uint64  `json:"mem_max,omitempty"`
}

type LogLine struct {
	TS     int64  `json:"ts"`
	Source string `json:"source"` // "docker:<container>" or "journal:<unit>"
	// stdout, stderr, or the journald priority name. Docker events (an OOM kill,
	// a non-zero exit) arrive on their container's source as "crit" / "err".
	Stream string `json:"stream"`
	Line   string `json:"line"`
}

// Deploy is what deploy/auto-update.sh last wrote to its state file.
type Deploy struct {
	Commit string `json:"commit"`
	At     string `json:"at"` // ISO-8601, as the script writes it
}
