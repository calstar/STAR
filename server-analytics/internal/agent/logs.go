package agent

import (
	"bufio"
	"context"
	"encoding/binary"
	"io"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/calstar/STAR/server-analytics/internal/wire"
)

// Caps on what one source may send per push, so a container stuck in a log storm
// costs the hub a bounded number of rows rather than all of them.
const (
	MaxLinesPerSource = 500
	MaxLineBytes      = 2048
	logBackfill       = 5 * time.Minute // on agent start, how far back to begin
)

// truncateLine caps a line at MaxLineBytes without splitting a UTF-8 rune.
func truncateLine(s string) string {
	s = strings.TrimRight(s, "\r\n")
	if len(s) <= MaxLineBytes {
		return s
	}
	cut := MaxLineBytes
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + " …[truncated]"
}

// splitTimestamp splits the RFC3339Nano prefix `timestamps=1` puts on each line.
func splitTimestamp(line string) (time.Time, string, bool) {
	ts, rest, ok := strings.Cut(line, " ")
	if !ok {
		return time.Time{}, "", false
	}
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return time.Time{}, "", false
	}
	return t, rest, true
}

// readDockerLogs decodes a logs response. Without a TTY the daemon multiplexes
// stdout and stderr into frames, each with an 8-byte header: stream id, three
// zero bytes, then the big-endian payload length. With a TTY it is raw stdout.
func readDockerLogs(r io.Reader, tty bool, emit func(stream, line string)) error {
	if tty {
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			emit("stdout", sc.Text())
		}
		return sc.Err()
	}
	br := bufio.NewReader(r)
	hdr := make([]byte, 8)
	// A frame is not a line: one write can carry several lines, and a long line
	// can span frames. Accumulate per stream and split on newlines.
	partial := map[string]*strings.Builder{"stdout": {}, "stderr": {}}
	flush := func(stream string, final bool) {
		b := partial[stream]
		s := b.String()
		for {
			i := strings.IndexByte(s, '\n')
			if i < 0 {
				break
			}
			emit(stream, s[:i])
			s = s[i+1:]
		}
		if final && s != "" {
			emit(stream, s)
			s = ""
		}
		b.Reset()
		b.WriteString(s)
	}
	for {
		if _, err := io.ReadFull(br, hdr); err != nil {
			flush("stdout", true)
			flush("stderr", true)
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				return nil
			}
			return err
		}
		stream := "stdout"
		if hdr[0] == 2 {
			stream = "stderr"
		}
		n := binary.BigEndian.Uint32(hdr[4:])
		if _, err := io.CopyN(partial[stream], br, int64(n)); err != nil {
			flush(stream, true)
			return err
		}
		flush(stream, false)
	}
}

// DockerLogs keeps a per-container cursor: the timestamp of the last line sent.
type DockerLogs struct {
	docker  *dockerClient
	cursors map[string]time.Time // container id -> last line's time
	started time.Time
}

func (d *DockerLogs) Collect(ctx context.Context, cs *Containers) []wire.LogLine {
	if d.cursors == nil {
		d.cursors = map[string]time.Time{}
	}
	var out []wire.LogLine
	live := map[string]bool{}
	for _, ct := range cs.byID {
		_, had := d.cursors[ct.id]
		running := ct.state == "running" || ct.state == "restarting"
		if !running && !had {
			continue
		}
		live[ct.id] = true
		since, ok := d.cursors[ct.id]
		if !ok {
			since = d.started.Add(-logBackfill)
		}
		q := url.Values{
			"stdout": {"1"}, "stderr": {"1"}, "timestamps": {"1"},
			// `since` is inclusive at whole-second resolution, so lines at the
			// cursor come back again; the comparison below drops them.
			"since": {strconv.FormatInt(since.Unix(), 10)},
			"tail":  {strconv.Itoa(MaxLinesPerSource)},
		}
		resp, err := d.docker.get(ctx, "/containers/"+ct.id+"/logs", q)
		if err != nil {
			continue
		}
		last := since
		source := "docker:" + ct.name
		_ = readDockerLogs(resp.Body, ct.tty, func(stream, raw string) {
			t, msg, ok := splitTimestamp(raw)
			if !ok || !t.After(since) {
				return
			}
			if t.After(last) {
				last = t
			}
			out = append(out, wire.LogLine{TS: t.UnixMilli(), Source: source, Stream: stream, Line: truncateLine(msg)})
		})
		resp.Body.Close()
		if running {
			d.cursors[ct.id] = last
		} else {
			// One last read after it stopped catches the lines it died with.
			delete(d.cursors, ct.id)
		}
	}
	for id := range d.cursors {
		if !live[id] {
			delete(d.cursors, id)
		}
	}
	return out
}
