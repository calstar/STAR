package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"time"

	"github.com/calstar/STAR/server-analytics/internal/wire"
)

// DockerEvents turns the daemon's container `oom` and `die` events into log lines
// on the container's own source. An OOM kill leaves nothing in the container's
// output -- the process is simply gone, and a proxy in front answers 502 -- so
// without this the only trace is a restart count that went up by one.
type DockerEvents struct {
	docker *dockerClient
	since  time.Time // events at or before this were already reported
}

type dockerEvent struct {
	Type     string `json:"Type"`
	Action   string `json:"Action"`
	TimeNano int64  `json:"timeNano"`
	Actor    struct {
		Attributes map[string]string `json:"Attributes"`
	} `json:"Actor"`
}

// fmtDockerTime is the daemon's since/until format: seconds with a fractional part.
func fmtDockerTime(t time.Time) string {
	return fmt.Sprintf("%d.%09d", t.Unix(), t.Nanosecond())
}

// eventLine is the log line for one event, or ok=false for one not worth one
// (a clean exit, a stop the operator asked for).
func eventLine(e dockerEvent) (wire.LogLine, bool) {
	name := e.Actor.Attributes["name"]
	ts := time.Unix(0, e.TimeNano).UnixMilli()
	switch e.Action {
	case "oom":
		return wire.LogLine{TS: ts, Source: "docker:" + name, Stream: "crit",
			Line: "OOM: the kernel killed a process in this container for exceeding its memory limit"}, true
	case "die":
		code := e.Actor.Attributes["exitCode"]
		if code == "" || code == "0" {
			return wire.LogLine{}, false
		}
		msg := "container exited with code " + code
		if code == "137" {
			msg += " (SIGKILL: the OOM killer, or a docker kill/stop timeout)"
		}
		return wire.LogLine{TS: ts, Source: "docker:" + name, Stream: "err", Line: msg}, true
	}
	return wire.LogLine{}, false
}

// readEvents decodes the daemon's stream of concatenated JSON objects.
func readEvents(r io.Reader, after time.Time) ([]wire.LogLine, error) {
	var out []wire.LogLine
	dec := json.NewDecoder(r)
	for {
		var e dockerEvent
		if err := dec.Decode(&e); err != nil {
			if errors.Is(err, io.EOF) {
				return out, nil
			}
			return out, err
		}
		if e.Type != "container" || e.TimeNano <= after.UnixNano() {
			continue
		}
		if l, ok := eventLine(e); ok {
			out = append(out, l)
		}
	}
}

// Collect returns the events since the last call. With `until` set the daemon
// answers with what it has and closes, rather than streaming. On error the
// window is kept, so the next push asks again.
func (d *DockerEvents) Collect(ctx context.Context, now time.Time) ([]wire.LogLine, error) {
	filters, _ := json.Marshal(map[string][]string{"type": {"container"}, "event": {"oom", "die"}})
	q := url.Values{
		"since":   {fmtDockerTime(d.since)},
		"until":   {fmtDockerTime(now)},
		"filters": {string(filters)},
	}
	resp, err := d.docker.get(ctx, "/events", q)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	out, err := readEvents(resp.Body, d.since)
	if err != nil {
		return out, err
	}
	d.since = now
	return out, nil
}
