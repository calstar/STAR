package hub

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/calstar/STAR/server-analytics/internal/wire"
)

const (
	ec2Token  = "ec2-token-0123456789"
	appsToken = "apps-token-0123456789"
)

func newTestServer(t *testing.T, admins *Admins) (*Server, *Store) {
	t.Helper()
	st, err := Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	tokens, err := ParseTokens("ec2:" + ec2Token + ", apps:" + appsToken)
	if err != nil {
		t.Fatal(err)
	}
	if admins == nil {
		admins = NewAdmins("", "", []string{"boss@berkeley.edu"})
	}
	ui := fstest.MapFS{"index.html": {Data: []byte("<html>panel</html>")}}
	return &Server{Store: st, Tokens: tokens, Admins: admins, UI: ui}, st
}

func push(t *testing.T, h http.Handler, token string, b wire.Batch) int {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	json.NewEncoder(zw).Encode(b)
	zw.Close()
	req := httptest.NewRequest("POST", "/api/ingest", &buf)
	req.Header.Set("Content-Encoding", "gzip")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code
}

func TestParseTokensRejectsShortOrMalformed(t *testing.T) {
	for _, bad := range []string{"ec2:short", "noseparator0123456789", ":0123456789abcdef"} {
		if _, err := ParseTokens(bad); err == nil {
			t.Errorf("ParseTokens(%q) accepted", bad)
		}
	}
	// A host whose token is not set yet (compose interpolated an empty var) is
	// skipped, not an error and not a host anyone can write as with "".
	toks, err := ParseTokens("ec2:0123456789abcdef,apps:")
	if err != nil || len(toks) != 1 || toks["0123456789abcdef"] != "ec2" {
		t.Errorf("ParseTokens with an unset host = %v, %v", toks, err)
	}
	if hostForToken(toks, "") != "" {
		t.Error("an empty bearer matched a host")
	}
}

func TestIngestAuth(t *testing.T) {
	s, _ := newTestServer(t, nil)
	h := s.Handler()
	now := time.Now().UnixMilli()
	b := wire.Batch{Host: "ec2", Samples: []wire.HostSample{{TS: now, CPU: 5}}}

	if c := push(t, h, "", b); c != http.StatusUnauthorized {
		t.Errorf("no token: %d", c)
	}
	if c := push(t, h, "wrong-token-0123456789", b); c != http.StatusUnauthorized {
		t.Errorf("wrong token: %d", c)
	}
	// The apps box's token must not be able to write as ec2.
	if c := push(t, h, appsToken, b); c != http.StatusForbidden {
		t.Errorf("apps token writing as ec2: %d, want 403", c)
	}
	if c := push(t, h, ec2Token, b); c != http.StatusNoContent {
		t.Errorf("good push: %d", c)
	}
}

func get(t *testing.T, h http.Handler, path, email string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("GET", path, nil)
	if email != "" {
		req.Header.Set("X-Auth-Email", email)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestPanelIsAdminsOnly(t *testing.T) {
	s, _ := newTestServer(t, nil)
	h := s.Handler()
	for _, p := range []string{"/api/hosts", "/api/logs", "/", "/hosts/ec2"} {
		if c := get(t, h, p, "someone@berkeley.edu").Code; c != http.StatusForbidden {
			t.Errorf("%s as non-admin: %d, want 403", p, c)
		}
		if c := get(t, h, p, "").Code; c != http.StatusForbidden {
			t.Errorf("%s with no identity: %d, want 403", p, c)
		}
		if c := get(t, h, p, "BOSS@berkeley.edu").Code; c != http.StatusOK {
			t.Errorf("%s as admin: %d, want 200", p, c)
		}
	}
}

func TestAdminsFromStarProject(t *testing.T) {
	up := true
	sp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/internal/admins" || r.Header.Get("X-Internal-Secret") != "s3cret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if !up {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		w.Write([]byte(`{"emails":["Admin@Berkeley.edu"]}`))
	}))
	defer sp.Close()

	a := NewAdmins(sp.URL, "s3cret", nil)
	a.refresh = 0
	if !a.IsAdmin(context.Background(), "admin@berkeley.edu") {
		t.Fatal("admin from STARProject not admitted")
	}
	if a.IsAdmin(context.Background(), "other@berkeley.edu") {
		t.Fatal("non-admin admitted")
	}

	// STARProject goes away: the last good list holds while fresh...
	up = false
	a.attempt = time.Time{}
	if !a.IsAdmin(context.Background(), "admin@berkeley.edu") {
		t.Error("a brief STARProject outage locked admins out")
	}
	// ...and once stale, nobody gets in.
	a.fetched = time.Now().Add(-a.staleFor - time.Second)
	a.attempt = time.Time{}
	if a.IsAdmin(context.Background(), "admin@berkeley.edu") {
		t.Error("stale admin list still admitting: should fail closed")
	}

	if NewAdmins(sp.URL, "wrong", nil).IsAdmin(context.Background(), "admin@berkeley.edu") {
		t.Error("admitted with a list STARProject refused to give")
	}
}

func TestIngestThenRead(t *testing.T) {
	s, _ := newTestServer(t, nil)
	h := s.Handler()
	now := time.Now()
	b := wire.Batch{
		Host:       "apps",
		Samples:    []wire.HostSample{{TS: now.Add(-15 * time.Second).UnixMilli(), CPU: 10, MemTotal: 100}, {TS: now.UnixMilli(), CPU: 30, MemTotal: 100}},
		Containers: []wire.ContainerSample{{TS: now.UnixMilli(), Name: "caddy", State: "running", Health: "unhealthy", CPU: 1.5}},
		Logs:       []wire.LogLine{{TS: now.UnixMilli(), Source: "docker:caddy", Stream: "stderr", Line: "100% busy_now"}, {TS: now.UnixMilli(), Source: "docker:caddy", Stream: "stdout", Line: "fine"}},
		Deploy:     &wire.Deploy{Commit: "abcdef0", At: "2026-10-02T00:00:00Z"},
	}
	if c := push(t, h, appsToken, b); c != http.StatusNoContent {
		t.Fatalf("push: %d", c)
	}

	var hosts []hostSummary
	json.Unmarshal(get(t, h, "/api/hosts", "boss@berkeley.edu").Body.Bytes(), &hosts)
	if len(hosts) != 1 || !hosts[0].Up || hosts[0].Latest == nil || hosts[0].Latest.CPU != 30 ||
		hosts[0].Containers.Unhealthy != 1 || *hosts[0].DeployCommit != "abcdef0" {
		t.Errorf("hosts = %+v", hosts)
	}

	// The search text is matched literally: % and _ are not wildcards.
	var logs []logRow
	json.Unmarshal(get(t, h, "/api/logs?q=100%25+busy_", "boss@berkeley.edu").Body.Bytes(), &logs)
	if len(logs) != 1 || logs[0].Line != "100% busy_now" {
		t.Errorf("search = %+v", logs)
	}
	json.Unmarshal(get(t, h, "/api/logs?q=0%25", "boss@berkeley.edu").Body.Bytes(), &logs)
	if len(logs) != 1 {
		t.Errorf("literal %% search = %+v", logs)
	}
	json.Unmarshal(get(t, h, "/api/logs?q=%25", "boss@berkeley.edu").Body.Bytes(), &logs)
	if len(logs) != 1 {
		t.Errorf("bare %% matched %d lines, want only the one containing it", len(logs))
	}
	json.Unmarshal(get(t, h, "/api/logs?stream=errors", "boss@berkeley.edu").Body.Bytes(), &logs)
	if len(logs) != 1 || logs[0].Stream != "stderr" {
		t.Errorf("errors only = %+v", logs)
	}

	var series struct {
		Series map[string][]any `json:"series"`
	}
	json.Unmarshal(get(t, h, "/api/hosts/apps/series?range=1h", "boss@berkeley.edu").Body.Bytes(), &series)
	if len(series.Series["cpu"]) == 0 {
		t.Errorf("series = %+v", series)
	}
	if c := get(t, h, "/api/hosts/apps/series?range=1y", "boss@berkeley.edu").Code; c != http.StatusBadRequest {
		t.Errorf("unknown range: %d", c)
	}
}

func TestFutureRowsDropped(t *testing.T) {
	s, st := newTestServer(t, nil)
	future := time.Now().Add(time.Hour).UnixMilli()
	push(t, s.Handler(), ec2Token, wire.Batch{Host: "ec2", Samples: []wire.HostSample{{TS: future}}})
	var n int
	st.db.QueryRow(`SELECT COUNT(*) FROM host_samples`).Scan(&n)
	if n != 0 {
		t.Errorf("%d future samples stored", n)
	}
}

func TestPickSeries(t *testing.T) {
	cases := []struct {
		rng    time.Duration
		rollup bool
		bucket time.Duration
	}{
		{time.Hour, false, 15 * time.Second},
		{24 * time.Hour, false, 3 * time.Minute},
		{RawRetention, false, 6 * time.Minute},
		{7 * 24 * time.Hour, true, 25 * time.Minute},
		{90 * 24 * time.Hour, true, 260 * time.Minute},
	}
	for _, c := range cases {
		rollup, b := pickSeries(c.rng)
		if rollup != c.rollup || b != c.bucket.Milliseconds() {
			t.Errorf("pickSeries(%s) = %v, %dms; want %v, %s", c.rng, rollup, b, c.rollup, c.bucket)
		}
		if n := c.rng.Milliseconds() / b; n > targetPoints+1 {
			t.Errorf("%s returns %d points", c.rng, n)
		}
	}
}

func TestMaintainRollsUpThenPrunes(t *testing.T) {
	_, st := newTestServer(t, nil)
	bucket := RollupBucket.Milliseconds()
	now := time.UnixMilli(time.Now().UnixMilli() / bucket * bucket).Add(2 * time.Minute)
	b0 := now.Add(-time.Hour).UnixMilli() / bucket * bucket
	var samples []wire.HostSample
	for i, cpu := range []float64{10, 20, 90} {
		samples = append(samples, wire.HostSample{TS: b0 + int64(i)*15000, CPU: cpu, MemUsed: uint64(100 * (i + 1))})
	}
	// An old sample, past raw retention.
	samples = append(samples, wire.HostSample{TS: now.Add(-RawRetention - time.Hour).UnixMilli(), CPU: 1})
	if err := st.Ingest(&wire.Batch{Host: "ec2", Samples: samples}, now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	st.db.Exec(`INSERT INTO logs (host, source, ts, stream, line) VALUES ('ec2','x',?,'stdout','old')`, now.Add(-LogRetention-time.Hour).UnixMilli())
	st.db.Exec(`INSERT INTO logs (host, source, ts, stream, line) VALUES ('ec2','x',?,'stdout','new')`, now.UnixMilli())

	if err := st.Maintain(now); err != nil {
		t.Fatal(err)
	}
	var avg, mx float64
	var memMax int64
	if err := st.db.QueryRow(`SELECT cpu, cpu_max, mem_max FROM host_rollups WHERE host='ec2' AND ts=?`, b0).Scan(&avg, &mx, &memMax); err != nil {
		t.Fatalf("rollup missing: %v", err)
	}
	if avg != 40 || mx != 90 || memMax != 300 {
		t.Errorf("rollup avg/max/mem = %v/%v/%v, want 40/90/300", avg, mx, memMax)
	}
	var raw, lg int
	st.db.QueryRow(`SELECT COUNT(*) FROM host_samples`).Scan(&raw)
	st.db.QueryRow(`SELECT COUNT(*) FROM logs`).Scan(&lg)
	if raw != 3 || lg != 1 {
		t.Errorf("after prune: %d raw (want 3), %d logs (want 1)", raw, lg)
	}
}

func TestCapLogs(t *testing.T) {
	_, st := newTestServer(t, nil)
	line := strings.Repeat("x", 1000)
	tx, _ := st.db.Begin()
	for i := 0; i < 1000; i++ {
		tx.Exec(`INSERT INTO logs (host, source, ts, stream, line) VALUES ('ec2','x',?,'stdout',?)`, i, line)
	}
	tx.Commit()
	max := int64(500 * (1000 + logRowOverhead))
	if err := st.capLogs(max); err != nil {
		t.Fatal(err)
	}
	var n int
	var oldest int64
	st.db.QueryRow(`SELECT COUNT(*), MIN(ts) FROM logs`).Scan(&n, &oldest)
	if n > 500 || n < 400 {
		t.Errorf("%d rows left, want about 450", n)
	}
	if oldest != int64(1000-n) {
		t.Errorf("oldest kept ts = %d: the cap should drop the oldest rows first", oldest)
	}
}
