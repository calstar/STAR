package agent

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/calstar/STAR/server-analytics/internal/wire"
)

func frame(stream byte, payload string) []byte {
	h := make([]byte, 8)
	h[0] = stream
	binary.BigEndian.PutUint32(h[4:], uint32(len(payload)))
	return append(h, payload...)
}

func TestReadDockerLogsMultiplexed(t *testing.T) {
	var buf bytes.Buffer
	buf.Write(frame(1, "one\ntw"))    // a line split across frames
	buf.Write(frame(2, "err line\n")) // interleaved stderr
	buf.Write(frame(1, "o\nthree"))   // last line without a newline
	var got []string
	err := readDockerLogs(&buf, false, func(stream, line string) { got = append(got, stream+"|"+line) })
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"stdout|one", "stderr|err line", "stdout|two", "stdout|three"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestReadDockerLogsTTY(t *testing.T) {
	var got []string
	readDockerLogs(strings.NewReader("a\nb\n"), true, func(s, l string) { got = append(got, s+"|"+l) })
	if strings.Join(got, ",") != "stdout|a,stdout|b" {
		t.Errorf("got %q", got)
	}
}

func TestTruncateLineKeepsUTF8(t *testing.T) {
	long := strings.Repeat("é", MaxLineBytes) // 2 bytes each
	got := truncateLine(long)
	if !utf8.ValidString(got) {
		t.Error("truncation split a rune")
	}
	if len(got) > MaxLineBytes+len(" …[truncated]") {
		t.Errorf("len = %d", len(got))
	}
	if truncateLine("short\r\n") != "short" {
		t.Error("trailing newline kept")
	}
}

func TestCapPerSourceKeepsNewest(t *testing.T) {
	var in []wire.LogLine
	for i := 0; i < 10; i++ {
		in = append(in, wire.LogLine{Source: "a", Line: fmt.Sprint(i)})
	}
	in = append(in, wire.LogLine{Source: "b", Line: "only"})
	out := capPerSource(in, 3)
	var a []string
	for _, l := range out {
		if l.Source == "a" {
			a = append(a, l.Line)
		}
	}
	if strings.Join(a, "") != "789" || len(out) != 4 {
		t.Errorf("got %v (all %d)", a, len(out))
	}
}

func TestParseJournal(t *testing.T) {
	out := `{"__CURSOR":"c1","__REALTIME_TIMESTAMP":"1700000000123456","_SYSTEMD_USER_UNIT":"sensor-daq.service","PRIORITY":"3","MESSAGE":"bridge down"}
{"__CURSOR":"c2","__REALTIME_TIMESTAMP":"1700000001000000","_SYSTEMD_USER_UNIT":"sensor-backend.service","PRIORITY":"6","MESSAGE":[104,105,255]}
not json
`
	lines, cursor := parseJournal([]byte(out))
	if cursor != "c2" || len(lines) != 2 {
		t.Fatalf("cursor %q, %d lines", cursor, len(lines))
	}
	if l := lines[0]; l.TS != 1700000000123 || l.Source != "journal:sensor-daq" || l.Stream != "err" || l.Line != "bridge down" {
		t.Errorf("line 0 = %+v", l)
	}
	if l := lines[1]; l.Line != "hi�" || l.Stream != "info" {
		t.Errorf("byte-array MESSAGE = %+v", l)
	}
}
