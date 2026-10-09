package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/calstar/STAR/server-analytics/internal/wire"
)

// JournalLogs reads the host's journal files (mounted read-only at Dir) for the
// systemd *user* units whose names start with one of Prefixes -- on the apps box,
// the natively run DAQ server's sensor-* units.
//
// It execs journalctl rather than linking libsystemd, so the binary stays static.
// It matches on _SYSTEMD_USER_UNIT directly: `journalctl --user-unit` would also
// require _UID to equal the caller's, and the agent runs as root.
type JournalLogs struct {
	Dir      string
	Prefixes []string

	units    []string
	unitsAt  time.Time
	cursor   string
	started  time.Time
	disabled bool
}

const unitsEvery = 10 * time.Minute

var priorityNames = []string{"emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"}

func (j *JournalLogs) refreshUnits(ctx context.Context, now time.Time) {
	j.unitsAt = now
	out, err := exec.CommandContext(ctx, "journalctl", "-D", j.Dir, "-F", "_SYSTEMD_USER_UNIT").Output()
	if err != nil {
		return
	}
	var units []string
	for _, u := range strings.Fields(string(out)) {
		for _, p := range j.Prefixes {
			if strings.HasPrefix(u, p) {
				units = append(units, u)
				break
			}
		}
	}
	sort.Strings(units)
	j.units = units
}

// journalMessage decodes MESSAGE, which journalctl writes as a string, or as an
// array of byte values when the message is not valid UTF-8.
func journalMessage(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var b []byte
	var ints []int
	if json.Unmarshal(raw, &ints) == nil {
		for _, n := range ints {
			b = append(b, byte(n))
		}
		return strings.ToValidUTF8(string(b), "�")
	}
	return ""
}

type journalEntry struct {
	Cursor   string          `json:"__CURSOR"`
	RealTime string          `json:"__REALTIME_TIMESTAMP"` // microseconds
	Unit     string          `json:"_SYSTEMD_USER_UNIT"`
	Priority string          `json:"PRIORITY"`
	Message  json.RawMessage `json:"MESSAGE"`
}

func parseJournal(out []byte) (lines []wire.LogLine, cursor string) {
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for sc.Scan() {
		var e journalEntry
		if json.Unmarshal(sc.Bytes(), &e) != nil {
			continue
		}
		cursor = e.Cursor
		us, _ := strconv.ParseInt(e.RealTime, 10, 64)
		stream := "info"
		if p, err := strconv.Atoi(e.Priority); err == nil && p >= 0 && p < len(priorityNames) {
			stream = priorityNames[p]
		}
		lines = append(lines, wire.LogLine{
			TS:     us / 1000,
			Source: "journal:" + strings.TrimSuffix(e.Unit, ".service"),
			Stream: stream,
			Line:   truncateLine(journalMessage(e.Message)),
		})
	}
	return lines, cursor
}

func (j *JournalLogs) Collect(ctx context.Context, now time.Time) []wire.LogLine {
	if j.disabled || j.Dir == "" {
		return nil
	}
	if now.Sub(j.unitsAt) >= unitsEvery {
		j.refreshUnits(ctx, now)
	}
	if len(j.units) == 0 {
		return nil
	}
	args := []string{"-D", j.Dir, "-o", "json", "--no-pager", "-n", strconv.Itoa(MaxLinesPerSource * len(j.units))}
	if j.cursor != "" {
		args = append(args, "--after-cursor", j.cursor)
	} else {
		args = append(args, "--since", "@"+strconv.FormatInt(j.started.Add(-logBackfill).Unix(), 10))
	}
	// Repeated matches on one field are ORed by journalctl.
	for _, u := range j.units {
		args = append(args, "_SYSTEMD_USER_UNIT="+u)
	}
	out, err := exec.CommandContext(ctx, "journalctl", args...).Output()
	if err != nil {
		if _, missing := err.(*exec.Error); missing {
			j.disabled = true // no journalctl in this image: stop trying
		}
		return nil
	}
	lines, cursor := parseJournal(out)
	if cursor != "" {
		j.cursor = cursor
	}
	return capPerSource(lines, MaxLinesPerSource)
}

// capPerSource keeps the newest max lines of each source. Input is oldest first.
func capPerSource(lines []wire.LogLine, max int) []wire.LogLine {
	count := map[string]int{}
	for _, l := range lines {
		count[l.Source]++
	}
	out := lines[:0:0]
	for _, l := range lines {
		if count[l.Source] > max {
			count[l.Source]--
			continue
		}
		out = append(out, l)
	}
	return out
}
