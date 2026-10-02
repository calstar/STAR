package hub

import (
	"database/sql"
	"encoding/json"
	"io/fs"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// DownAfter is how long a host may go without a push before the panel calls it
// down. Agents push every 30 s, so this is four missed pushes.
const DownAfter = 2 * time.Minute

type Server struct {
	Store    *Store
	Tokens   map[string]string // token -> host
	Admins   *Admins
	DevEmail string // only when no X-Auth-Email arrives, i.e. local dev
	UI       fs.FS
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	// Ingest is the one path Caddy does not cookie-gate (agents have no cookie);
	// it authenticates by bearer token instead.
	mux.HandleFunc("POST /api/ingest", s.handleIngest)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })

	api := http.NewServeMux()
	api.HandleFunc("GET /api/me", s.handleMe)
	api.HandleFunc("GET /api/hosts", s.handleHosts)
	api.HandleFunc("GET /api/hosts/{host}/series", s.handleHostSeries)
	api.HandleFunc("GET /api/hosts/{host}/containers", s.handleContainers)
	api.HandleFunc("GET /api/hosts/{host}/containers/{name}/series", s.handleContainerSeries)
	api.HandleFunc("GET /api/logs", s.handleLogs)
	api.HandleFunc("GET /api/log-sources", s.handleLogSources)
	mux.Handle("/api/", s.requireAdmin(api))
	mux.Handle("/", s.requireAdmin(spa(s.UI)))
	return securityHeaders(mux)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) email(r *http.Request) string {
	if e := r.Header.Get("X-Auth-Email"); e != "" {
		return e
	}
	return s.DevEmail
}

func (s *Server) requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		email := s.email(r)
		if !s.Admins.IsAdmin(r.Context(), email) {
			if strings.HasPrefix(r.URL.Path, "/api/") {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "not a STARProject admin"})
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusForbidden)
			w.Write([]byte(forbiddenPage))
			return
		}
		next.ServeHTTP(w, r)
	})
}

const forbiddenPage = `<!doctype html><meta charset="utf-8"><title>STAR Analytics</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#171717">
<h1 style="font-size:1.375rem">Admins only</h1>
<p>Server analytics is open to STARProject admins. Ask an admin to add you under
Workspace setup → Admins in <a href="https://project.starberkeley.org">STARProject</a>.</p>`

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, err error) {
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"email": s.email(r)})
}

type hostSummary struct {
	Host         string   `json:"host"`
	LastSeen     int64    `json:"last_seen"`
	Up           bool     `json:"up"`
	DeployCommit *string  `json:"deploy_commit"`
	DeployAt     *string  `json:"deploy_at"`
	Latest       *latest  `json:"latest"`
	Containers   ctCounts `json:"containers"`
}

type latest struct {
	TS        int64   `json:"ts"`
	CPU       float64 `json:"cpu"`
	Cores     int     `json:"cores"`
	MemUsed   int64   `json:"mem_used"`
	MemTotal  int64   `json:"mem_total"`
	SwapUsed  int64   `json:"swap_used"`
	SwapTotal int64   `json:"swap_total"`
	Load1     float64 `json:"load1"`
	DiskUsed  int64   `json:"disk_used"`
	DiskTotal int64   `json:"disk_total"`
	NetRx     float64 `json:"net_rx"`
	NetTx     float64 `json:"net_tx"`
	Uptime    float64 `json:"uptime"`
}

type ctCounts struct {
	Running   int `json:"running"`
	Total     int `json:"total"`
	Unhealthy int `json:"unhealthy"`
}

func (s *Server) handleHosts(w http.ResponseWriter, r *http.Request) {
	rows, err := s.Store.db.Query(`SELECT host, last_seen, deploy_commit, deploy_at FROM hosts ORDER BY host`)
	if err != nil {
		fail(w, err)
		return
	}
	var out []hostSummary
	for rows.Next() {
		var h hostSummary
		if err := rows.Scan(&h.Host, &h.LastSeen, &h.DeployCommit, &h.DeployAt); err != nil {
			rows.Close()
			fail(w, err)
			return
		}
		out = append(out, h)
	}
	rows.Close()
	now := time.Now().UnixMilli()
	for i := range out {
		h := &out[i]
		h.Up = now-h.LastSeen < DownAfter.Milliseconds()
		var l latest
		err := s.Store.db.QueryRow(`SELECT ts, cpu, cores, mem_used, mem_total, swap_used, swap_total, load1,
			disk_used, disk_total, net_rx, net_tx, uptime FROM host_samples WHERE host = ? ORDER BY ts DESC LIMIT 1`, h.Host).
			Scan(&l.TS, &l.CPU, &l.Cores, &l.MemUsed, &l.MemTotal, &l.SwapUsed, &l.SwapTotal, &l.Load1,
				&l.DiskUsed, &l.DiskTotal, &l.NetRx, &l.NetTx, &l.Uptime)
		if err == nil {
			h.Latest = &l
		} else if err != sql.ErrNoRows {
			fail(w, err)
			return
		}
		if err := s.Store.db.QueryRow(`SELECT COALESCE(SUM(state = 'running'), 0), COUNT(*),
			COALESCE(SUM(health = 'unhealthy'), 0) FROM containers WHERE host = ?`, h.Host).
			Scan(&h.Containers.Running, &h.Containers.Total, &h.Containers.Unhealthy); err != nil {
			fail(w, err)
			return
		}
	}
	if out == nil {
		out = []hostSummary{}
	}
	writeJSON(w, http.StatusOK, out)
}

var ranges = map[string]time.Duration{
	"1h": time.Hour, "6h": 6 * time.Hour, "24h": 24 * time.Hour,
	"7d": 7 * 24 * time.Hour, "30d": 30 * 24 * time.Hour, "90d": 90 * 24 * time.Hour,
}

const (
	targetPoints = 500
	rawStep      = 15 * time.Second
)

// pickSeries chooses the table and bucket for a range: raw rows while they still
// exist, rollups beyond, and a bucket wide enough to return about targetPoints.
func pickSeries(rng time.Duration) (rollup bool, bucketMs int64) {
	base := rawStep
	if rng > RawRetention {
		rollup, base = true, RollupBucket
	}
	b := rng / targetPoints
	if b < base {
		b = base
	}
	b = (b + base - 1) / base * base
	return rollup, b.Milliseconds()
}

func parseRange(r *http.Request) (time.Duration, bool) {
	v := r.URL.Query().Get("range")
	if v == "" {
		v = "1h"
	}
	d, ok := ranges[v]
	return d, ok
}

// columns turns rows into the column arrays uPlot draws directly.
func columns(rows *sql.Rows) (map[string][]any, error) {
	defer rows.Close()
	names, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	out := make(map[string][]any, len(names))
	for _, n := range names {
		out[n] = []any{}
	}
	vals := make([]any, len(names))
	ptrs := make([]any, len(names))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	for rows.Next() {
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		for i, n := range names {
			out[n] = append(out[n], vals[i])
		}
	}
	return out, rows.Err()
}

func (s *Server) handleHostSeries(w http.ResponseWriter, r *http.Request) {
	rng, ok := parseRange(r)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown range"})
		return
	}
	rollup, bucket := pickSeries(rng)
	from := time.Now().Add(-rng).UnixMilli()
	q := `SELECT ts / ?1 * ?1 AS ts, AVG(cpu) AS cpu, MAX(cpu) AS cpu_max, AVG(mem_used) AS mem_used,
		MAX(mem_used) AS mem_max, MAX(mem_total) AS mem_total, AVG(swap_used) AS swap_used,
		AVG(load1) AS load1, AVG(load5) AS load5, AVG(load15) AS load15, MAX(disk_used) AS disk_used,
		MAX(disk_total) AS disk_total, AVG(net_rx) AS net_rx, AVG(net_tx) AS net_tx
		FROM host_samples WHERE host = ?2 AND ts >= ?3 GROUP BY ts / ?1 ORDER BY 1`
	if rollup {
		q = `SELECT ts / ?1 * ?1 AS ts, AVG(cpu) AS cpu, MAX(cpu_max) AS cpu_max, AVG(mem_used) AS mem_used,
			MAX(mem_max) AS mem_max, MAX(mem_total) AS mem_total, AVG(swap_used) AS swap_used,
			AVG(load1) AS load1, AVG(load5) AS load5, AVG(load15) AS load15, MAX(disk_used) AS disk_used,
			MAX(disk_total) AS disk_total, AVG(net_rx) AS net_rx, AVG(net_tx) AS net_tx
			FROM host_rollups WHERE host = ?2 AND ts >= ?3 GROUP BY ts / ?1 ORDER BY 1`
	}
	rows, err := s.Store.db.Query(q, bucket, r.PathValue("host"), from)
	if err != nil {
		fail(w, err)
		return
	}
	cols, err := columns(rows)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"bucket_ms": bucket, "series": cols})
}

func (s *Server) handleContainers(w http.ResponseWriter, r *http.Request) {
	rows, err := s.Store.db.Query(`SELECT name, ts, image, state, health, restarts, cpu, mem_used, mem_limit
		FROM containers WHERE host = ? ORDER BY name`, r.PathValue("host"))
	if err != nil {
		fail(w, err)
		return
	}
	type ct struct {
		Name     string  `json:"name"`
		TS       int64   `json:"ts"`
		Image    string  `json:"image"`
		State    string  `json:"state"`
		Health   string  `json:"health"`
		Restarts int     `json:"restarts"`
		CPU      float64 `json:"cpu"`
		MemUsed  int64   `json:"mem_used"`
		MemLimit int64   `json:"mem_limit"`
		// Last hour at one-minute buckets, for the table's sparklines.
		Spark map[string][]any `json:"spark"`
	}
	var out []ct
	for rows.Next() {
		var c ct
		if err := rows.Scan(&c.Name, &c.TS, &c.Image, &c.State, &c.Health, &c.Restarts, &c.CPU, &c.MemUsed, &c.MemLimit); err != nil {
			rows.Close()
			fail(w, err)
			return
		}
		out = append(out, c)
	}
	rows.Close()
	from := time.Now().Add(-time.Hour).UnixMilli()
	for i := range out {
		sr, err := s.Store.db.Query(`SELECT ts / 60000 * 60000 AS ts, AVG(cpu) AS cpu, AVG(mem_used) AS mem_used
			FROM container_samples WHERE host = ? AND name = ? AND ts >= ? GROUP BY ts / 60000 ORDER BY 1`,
			r.PathValue("host"), out[i].Name, from)
		if err != nil {
			fail(w, err)
			return
		}
		if out[i].Spark, err = columns(sr); err != nil {
			fail(w, err)
			return
		}
	}
	if out == nil {
		out = []ct{}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleContainerSeries(w http.ResponseWriter, r *http.Request) {
	rng, ok := parseRange(r)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown range"})
		return
	}
	rollup, bucket := pickSeries(rng)
	table, cpuMax, memMax := "container_samples", "MAX(cpu)", "MAX(mem_used)"
	if rollup {
		table, cpuMax, memMax = "container_rollups", "MAX(cpu_max)", "MAX(mem_max)"
	}
	rows, err := s.Store.db.Query(`SELECT ts / ?1 * ?1 AS ts, AVG(cpu) AS cpu, `+cpuMax+` AS cpu_max,
		AVG(mem_used) AS mem_used, `+memMax+` AS mem_max FROM `+table+`
		WHERE host = ?2 AND name = ?3 AND ts >= ?4 GROUP BY ts / ?1 ORDER BY 1`,
		bucket, r.PathValue("host"), r.PathValue("name"), time.Now().Add(-rng).UnixMilli())
	if err != nil {
		fail(w, err)
		return
	}
	cols, err := columns(rows)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"bucket_ms": bucket, "series": cols})
}

type logRow struct {
	ID     int64  `json:"id"`
	Host   string `json:"host"`
	Source string `json:"source"`
	TS     int64  `json:"ts"`
	Stream string `json:"stream"`
	Line   string `json:"line"`
}

// handleLogs pages newest first by id. before=<id> loads older lines; after=<id>
// returns only lines newer than the newest one the panel already shows (tail).
func (s *Server) handleLogs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	where := []string{"1=1"}
	var args []any
	if v := q.Get("host"); v != "" {
		where, args = append(where, "host = ?"), append(args, v)
	}
	if v := q.Get("source"); v != "" {
		where, args = append(where, "source = ?"), append(args, v)
	}
	if v := q.Get("q"); v != "" {
		where, args = append(where, `line LIKE ? ESCAPE '\'`), append(args, likeEscape(v))
	}
	if v := q.Get("stream"); v == "errors" {
		where = append(where, "stream IN ('stderr','emerg','alert','crit','err')")
	}
	if v, err := strconv.ParseInt(q.Get("before"), 10, 64); err == nil {
		where, args = append(where, "id < ?"), append(args, v)
	}
	if v, err := strconv.ParseInt(q.Get("after"), 10, 64); err == nil {
		where, args = append(where, "id > ?"), append(args, v)
	}
	args = append(args, limit)
	rows, err := s.Store.db.Query(`SELECT id, host, source, ts, stream, line FROM logs WHERE `+
		strings.Join(where, " AND ")+` ORDER BY id DESC LIMIT ?`, args...)
	if err != nil {
		fail(w, err)
		return
	}
	defer rows.Close()
	out := []logRow{}
	for rows.Next() {
		var l logRow
		var stream sql.NullString
		if err := rows.Scan(&l.ID, &l.Host, &l.Source, &l.TS, &stream, &l.Line); err != nil {
			fail(w, err)
			return
		}
		l.Stream = stream.String
		out = append(out, l)
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleLogSources(w http.ResponseWriter, r *http.Request) {
	rows, err := s.Store.db.Query(`SELECT DISTINCT host, source FROM logs ORDER BY host, source`)
	if err != nil {
		fail(w, err)
		return
	}
	defer rows.Close()
	type src struct {
		Host   string `json:"host"`
		Source string `json:"source"`
	}
	out := []src{}
	for rows.Next() {
		var x src
		if err := rows.Scan(&x.Host, &x.Source); err != nil {
			fail(w, err)
			return
		}
		out = append(out, x)
	}
	writeJSON(w, http.StatusOK, out)
}

// spa serves the built panel, sending every unknown path to index.html so the
// client-side routes survive a reload.
func spa(ui fs.FS) http.Handler {
	files := http.FileServerFS(ui)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p != "" {
			if f, err := ui.Open(p); err == nil {
				f.Close()
				if strings.HasPrefix(p, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				files.ServeHTTP(w, r)
				return
			}
		}
		idx, err := fs.ReadFile(ui, "index.html")
		if err != nil {
			http.Error(w, "panel not built (run npm run build in web/)", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(idx)
	})
}
