package hub

import (
	"context"
	"log"
	"time"
)

const (
	RawRetention    = 48 * time.Hour
	RollupRetention = 90 * 24 * time.Hour
	RollupBucket    = 5 * time.Minute
	LogRetention    = 3 * 24 * time.Hour
	LogMaxBytes     = 200 << 20
	// Rows are re-rolled over this window each pass, so a bucket that was still
	// filling last time is completed this time. It must stay well inside
	// RawRetention, or a bucket would lose its raw rows before being rolled.
	rollupWindow   = 3 * time.Hour
	logRowOverhead = 64 // bytes per row beyond the line itself, for the cap estimate
)

// Maintain rolls up and prunes. Idempotent; the hub runs it every few minutes.
func (s *Store) Maintain(now time.Time) error {
	bucket := RollupBucket.Milliseconds()
	// Only completed buckets: one still filling would be rolled from part of its
	// rows and then (correctly) replaced next pass, but it would show as a dip
	// in between.
	end := now.UnixMilli() / bucket * bucket
	start := now.Add(-rollupWindow).UnixMilli() / bucket * bucket
	if _, err := s.db.Exec(`INSERT OR REPLACE INTO host_rollups
		SELECT host, ts / ?1 * ?1, AVG(cpu), MAX(cpu), AVG(mem_used), MAX(mem_used), MAX(mem_total),
			AVG(swap_used), AVG(load1), AVG(load5), AVG(load15), MAX(disk_used), MAX(disk_total),
			AVG(net_rx), AVG(net_tx)
		FROM host_samples WHERE ts >= ?2 AND ts < ?3 GROUP BY host, ts / ?1`, bucket, start, end); err != nil {
		return err
	}
	if _, err := s.db.Exec(`INSERT OR REPLACE INTO container_rollups
		SELECT host, name, ts / ?1 * ?1, AVG(cpu), MAX(cpu), AVG(mem_used), MAX(mem_used)
		FROM container_samples WHERE ts >= ?2 AND ts < ?3 GROUP BY host, name, ts / ?1`, bucket, start, end); err != nil {
		return err
	}

	rawCut := now.Add(-RawRetention).UnixMilli()
	rollCut := now.Add(-RollupRetention).UnixMilli()
	for _, q := range []struct {
		sql string
		arg int64
	}{
		{`DELETE FROM host_samples WHERE ts < ?`, rawCut},
		{`DELETE FROM container_samples WHERE ts < ?`, rawCut},
		{`DELETE FROM host_rollups WHERE ts < ?`, rollCut},
		{`DELETE FROM container_rollups WHERE ts < ?`, rollCut},
		{`DELETE FROM logs WHERE ts < ?`, now.Add(-LogRetention).UnixMilli()},
		// A container that has been gone this long is not coming back.
		{`DELETE FROM containers WHERE ts < ?`, now.Add(-24 * time.Hour).UnixMilli()},
	} {
		if _, err := s.db.Exec(q.sql, q.arg); err != nil {
			return err
		}
	}
	return s.capLogs(LogMaxBytes)
}

// capLogs drops the oldest log rows until the estimated size fits under max.
func (s *Store) capLogs(max int64) error {
	var rows, bytes int64
	if err := s.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(LENGTH(line)), 0) FROM logs`).Scan(&rows, &bytes); err != nil {
		return err
	}
	total := bytes + rows*logRowOverhead
	if total <= max || rows == 0 {
		return nil
	}
	// Drop proportionally, with 10% headroom so this is not redone every pass.
	drop := int64(float64(rows) * (1 - 0.9*float64(max)/float64(total)))
	_, err := s.db.Exec(`DELETE FROM logs WHERE id <= (SELECT id FROM logs ORDER BY id LIMIT 1 OFFSET ?)`, drop-1)
	return err
}

func (s *Store) RunMaintenance(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if err := s.Maintain(time.Now()); err != nil {
			log.Printf("maintenance: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
