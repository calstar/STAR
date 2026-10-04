package agent

import (
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

const procStat = `cpu  100 0 50 800 50 0 0 0 0 0
cpu0 50 0 25 400 25 0 0 0 0 0
cpu1 50 0 25 400 25 0 0 0 0 0
intr 12345
`

func TestParseProcStat(t *testing.T) {
	c, cores, err := parseProcStat(procStat)
	if err != nil {
		t.Fatal(err)
	}
	if cores != 2 {
		t.Errorf("cores = %d, want 2", cores)
	}
	// busy excludes idle (800) and iowait (50).
	if c.busy != 150 || c.total != 1000 {
		t.Errorf("busy/total = %d/%d, want 150/1000", c.busy, c.total)
	}
}

func TestCPUPercent(t *testing.T) {
	prev := cpuTimes{busy: 150, total: 1000}
	cur := cpuTimes{busy: 175, total: 1100} // 25 busy of 100 elapsed
	if got := cpuPercent(prev, cur); math.Abs(got-25) > 1e-9 {
		t.Errorf("cpuPercent = %v, want 25", got)
	}
	// A counter that went backwards (host rebooted between samples) is not a
	// negative or enormous percentage.
	if got := cpuPercent(cur, prev); got != 0 {
		t.Errorf("cpuPercent after reset = %v, want 0", got)
	}
}

func TestParseMeminfo(t *testing.T) {
	m, err := parseMeminfo("MemTotal:  1000 kB\nMemFree: 100 kB\nMemAvailable:  400 kB\nSwapTotal: 50 kB\nSwapFree: 20 kB\n")
	if err != nil {
		t.Fatal(err)
	}
	if m.total != 1000*1024 || m.avail != 400*1024 || m.swapTotal != 50*1024 || m.swapFree != 20*1024 {
		t.Errorf("got %+v", m)
	}
	if _, err := parseMeminfo("MemTotal: 1 kB\n"); err == nil {
		t.Error("meminfo without MemAvailable should fail, not report 100% used")
	}
}

func TestParseNetDevSkipsLoopbackAndBridges(t *testing.T) {
	s := `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9999 1 0 0 0 0 0 0 9999 1 0 0 0 0 0 0
  eth0: 1000 1 0 0 0 0 0 0 2000 1 0 0 0 0 0 0
docker0: 500 1 0 0 0 0 0 0 500 1 0 0 0 0 0 0
vethab12: 500 1 0 0 0 0 0 0 500 1 0 0 0 0 0 0
br-1234: 500 1 0 0 0 0 0 0 500 1 0 0 0 0 0 0
 wlan0: 10 1 0 0 0 0 0 0 20 1 0 0 0 0 0 0
`
	rx, tx := parseNetDev(s)
	if rx != 1010 || tx != 2020 {
		t.Errorf("rx/tx = %d/%d, want 1010/2020", rx, tx)
	}
}

func TestHostSampleRates(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		p := filepath.Join(dir, name)
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("stat", procStat)
	write("meminfo", "MemTotal: 1000 kB\nMemAvailable: 250 kB\n")
	write("loadavg", "0.50 0.25 0.10 1/100 42\n")
	write("uptime", "3600.5 7000.0\n")
	write("1/net/dev", "eth0: 1000 0 0 0 0 0 0 0 4000 0 0 0 0 0 0 0\n")

	h := &HostReader{Proc: dir, Root: dir}
	t0 := time.Unix(1000, 0)
	if s, err := h.Sample(t0); err != nil || s != nil {
		t.Fatalf("first sample should be nil (no rate yet), got %+v, %v", s, err)
	}
	write("stat", "cpu  150 0 100 850 50 0 0 0\ncpu0 1\n") // +100 busy of +150 total
	write("1/net/dev", "eth0: 3000 0 0 0 0 0 0 0 5000 0 0 0 0 0 0 0\n")
	s, err := h.Sample(t0.Add(10 * time.Second))
	if err != nil || s == nil {
		t.Fatalf("second sample: %+v, %v", s, err)
	}
	if math.Abs(s.CPU-100.0*100/150) > 1e-9 {
		t.Errorf("CPU = %v", s.CPU)
	}
	if s.NetRx != 200 || s.NetTx != 100 {
		t.Errorf("net = %v/%v B/s, want 200/100", s.NetRx, s.NetTx)
	}
	if s.MemUsed != 750*1024 || s.MemTotal != 1000*1024 {
		t.Errorf("mem = %d/%d", s.MemUsed, s.MemTotal)
	}
	if s.Load1 != 0.5 || s.Load15 != 0.1 || s.Uptime != 3600.5 {
		t.Errorf("load/uptime = %v %v %v", s.Load1, s.Load15, s.Uptime)
	}
	if s.DiskTotal == 0 {
		t.Error("statfs on the root gave no disk size")
	}
}

func TestReadDeploy(t *testing.T) {
	p := filepath.Join(t.TempDir(), "state")
	os.WriteFile(p, []byte("deployed_commit=abc1234def\ndeployed_at=2026-10-02T03:00:00Z\ncompose_dir=/x\n# digests\n"), 0o644)
	d := readDeploy(p)
	if d == nil || d.Commit != "abc1234def" || d.At != "2026-10-02T03:00:00Z" {
		t.Errorf("got %+v", d)
	}
	if readDeploy(filepath.Join(t.TempDir(), "missing")) != nil {
		t.Error("a missing state file should mean no deploy, not an empty one")
	}
}
