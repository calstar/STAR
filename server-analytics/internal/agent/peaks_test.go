package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A memory spike that comes and goes between two samples is invisible to the
// samples themselves; the peek between them is what records it.
func TestHostPeekKeepsSpikeBetweenSamples(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("stat", procStat)
	write("meminfo", "MemTotal: 1000 kB\nMemAvailable: 800 kB\n")
	h := &HostReader{Proc: dir, Root: dir}
	t0 := time.Unix(1000, 0)
	h.Sample(t0)

	h.Peek(t0.Add(time.Second))
	write("meminfo", "MemTotal: 1000 kB\nMemAvailable: 100 kB\n") // spike: 900 kB used
	write("stat", "cpu  190 0 100 810 50 0 0 0\ncpu0 1\n")        // +90 busy of +100: 90%
	h.Peek(t0.Add(2 * time.Second))
	write("meminfo", "MemTotal: 1000 kB\nMemAvailable: 800 kB\n") // gone again
	write("stat", "cpu  191 0 100 899 50 0 0 0\ncpu0 1\n")

	s, err := h.Sample(t0.Add(15 * time.Second))
	if err != nil || s == nil {
		t.Fatalf("sample: %+v, %v", s, err)
	}
	if s.MemUsed != 200*1024 {
		t.Errorf("MemUsed = %d, want the 200 kB of now", s.MemUsed)
	}
	if s.MemMax != 900*1024 {
		t.Errorf("MemMax = %d, want the 900 kB spike", s.MemMax)
	}
	if s.CPUMax < 89.9 || s.CPUMax < s.CPU {
		t.Errorf("CPUMax = %v (CPU %v), want the 90%% spike", s.CPUMax, s.CPU)
	}
	// Peaks reset per sample: with no peeks, the next peak is the sample itself.
	s2, _ := h.Sample(t0.Add(30 * time.Second))
	if s2.MemMax != s2.MemUsed {
		t.Errorf("MemMax after reset = %d, want MemUsed %d", s2.MemMax, s2.MemUsed)
	}
}

const eventStream = `{"Type":"container","Action":"oom","timeNano":2000000000,"Actor":{"Attributes":{"name":"api"}}}
{"Type":"container","Action":"die","timeNano":2100000000,"Actor":{"Attributes":{"name":"api","exitCode":"137"}}}
{"Type":"container","Action":"die","timeNano":2200000000,"Actor":{"Attributes":{"name":"job","exitCode":"0"}}}
{"Type":"container","Action":"oom","timeNano":500000000,"Actor":{"Attributes":{"name":"old"}}}
`

func TestReadEventsReportsOOMAndCrashes(t *testing.T) {
	lines, err := readEvents(strings.NewReader(eventStream), time.Unix(1, 0))
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 2 {
		t.Fatalf("lines = %+v, want the oom and the 137 exit (not the clean exit, not the old event)", lines)
	}
	if lines[0].Source != "docker:api" || lines[0].Stream != "crit" || !strings.Contains(lines[0].Line, "OOM") {
		t.Errorf("oom line = %+v", lines[0])
	}
	if lines[1].Stream != "err" || !strings.Contains(lines[1].Line, "137") || lines[1].TS != 2100 {
		t.Errorf("die line = %+v", lines[1])
	}
}
