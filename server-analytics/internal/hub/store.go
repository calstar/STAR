// Package hub stores what the agents push and serves it to the panel.
package hub

import (
	"database/sql"
	"fmt"
	"strings"

	"github.com/calstar/STAR/server-analytics/internal/wire"
	_ "modernc.org/sqlite"
)

type Store struct{ db *sql.DB }

// Raw samples are kept for RawRetention, then only as RollupBucket averages
// and maxima. See retention.go.
const schema = `
CREATE TABLE IF NOT EXISTS host_samples (
	host TEXT NOT NULL, ts INTEGER NOT NULL,
	cpu REAL, cores INTEGER, mem_used INTEGER, mem_total INTEGER,
	swap_used INTEGER, swap_total INTEGER, load1 REAL, load5 REAL, load15 REAL,
	disk_used INTEGER, disk_total INTEGER, net_rx REAL, net_tx REAL, uptime REAL,
	PRIMARY KEY (host, ts)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS host_rollups (
	host TEXT NOT NULL, ts INTEGER NOT NULL,
	cpu REAL, cpu_max REAL, mem_used INTEGER, mem_max INTEGER, mem_total INTEGER,
	swap_used INTEGER, load1 REAL, load5 REAL, load15 REAL,
	disk_used INTEGER, disk_total INTEGER, net_rx REAL, net_tx REAL,
	PRIMARY KEY (host, ts)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS container_samples (
	host TEXT NOT NULL, name TEXT NOT NULL, ts INTEGER NOT NULL,
	cpu REAL, mem_used INTEGER,
	PRIMARY KEY (host, name, ts)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS container_rollups (
	host TEXT NOT NULL, name TEXT NOT NULL, ts INTEGER NOT NULL,
	cpu REAL, cpu_max REAL, mem_used INTEGER, mem_max INTEGER,
	PRIMARY KEY (host, name, ts)
) WITHOUT ROWID;
-- Latest state per container: the table on the host page, not a time series.
CREATE TABLE IF NOT EXISTS containers (
	host TEXT NOT NULL, name TEXT NOT NULL, ts INTEGER NOT NULL,
	image TEXT, state TEXT, health TEXT, restarts INTEGER,
	cpu REAL, mem_used INTEGER, mem_limit INTEGER,
	PRIMARY KEY (host, name)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS logs (
	id INTEGER PRIMARY KEY,
	host TEXT NOT NULL, source TEXT NOT NULL, ts INTEGER NOT NULL,
	stream TEXT, line TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS logs_ts ON logs (ts);
CREATE INDEX IF NOT EXISTS logs_host_source_ts ON logs (host, source, ts);
CREATE TABLE IF NOT EXISTS hosts (
	host TEXT PRIMARY KEY, last_seen INTEGER NOT NULL,
	deploy_commit TEXT, deploy_at TEXT
);
`

func Open(path string) (*Store, error) {
	// One writer connection: SQLite serialises writes anyway, and a single
	// connection keeps the hub's memory flat.
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("schema: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Ingest writes one batch in a single transaction. Re-sent rows (an agent that
// retried after a lost response) replace themselves rather than duplicating,
// except logs, which have no natural key; a retry costs at most one push's
// worth of repeated lines.
func (s *Store) Ingest(b *wire.Batch, now int64) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	hs, err := tx.Prepare(`INSERT OR REPLACE INTO host_samples VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
	if err != nil {
		return err
	}
	defer hs.Close()
	for _, x := range b.Samples {
		if _, err := hs.Exec(b.Host, x.TS, x.CPU, x.Cores, x.MemUsed, x.MemTotal, x.SwapUsed, x.SwapTotal,
			x.Load1, x.Load5, x.Load15, x.DiskUsed, x.DiskTotal, x.NetRx, x.NetTx, x.Uptime); err != nil {
			return err
		}
	}

	cs, err := tx.Prepare(`INSERT OR REPLACE INTO container_samples VALUES (?,?,?,?,?)`)
	if err != nil {
		return err
	}
	defer cs.Close()
	cur, err := tx.Prepare(`INSERT INTO containers VALUES (?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT (host, name) DO UPDATE SET ts=excluded.ts, image=excluded.image, state=excluded.state,
		health=excluded.health, restarts=excluded.restarts, cpu=excluded.cpu, mem_used=excluded.mem_used,
		mem_limit=excluded.mem_limit WHERE excluded.ts >= containers.ts`)
	if err != nil {
		return err
	}
	defer cur.Close()
	for _, x := range b.Containers {
		if x.State == "running" {
			if _, err := cs.Exec(b.Host, x.Name, x.TS, x.CPU, x.MemUsed); err != nil {
				return err
			}
		}
		if _, err := cur.Exec(b.Host, x.Name, x.TS, x.Image, x.State, x.Health, x.Restarts, x.CPU, x.MemUsed, x.MemLimit); err != nil {
			return err
		}
	}

	ls, err := tx.Prepare(`INSERT INTO logs (host, source, ts, stream, line) VALUES (?,?,?,?,?)`)
	if err != nil {
		return err
	}
	defer ls.Close()
	for _, x := range b.Logs {
		if _, err := ls.Exec(b.Host, x.Source, x.TS, x.Stream, x.Line); err != nil {
			return err
		}
	}

	var dc, da any
	if b.Deploy != nil {
		dc, da = b.Deploy.Commit, b.Deploy.At
	}
	if _, err := tx.Exec(`INSERT INTO hosts VALUES (?,?,?,?) ON CONFLICT (host) DO UPDATE SET
		last_seen=excluded.last_seen,
		deploy_commit=COALESCE(excluded.deploy_commit, hosts.deploy_commit),
		deploy_at=COALESCE(excluded.deploy_at, hosts.deploy_at)`, b.Host, now, dc, da); err != nil {
		return err
	}
	return tx.Commit()
}

// likeEscape makes a user's search text match literally inside LIKE.
func likeEscape(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + r.Replace(s) + "%"
}
