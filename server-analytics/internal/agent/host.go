package agent

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/calstar/STAR/server-analytics/internal/wire"
)

// cpuTimes is the aggregate "cpu" line of /proc/stat, in jiffies.
type cpuTimes struct{ busy, total uint64 }

func parseProcStat(s string) (cpuTimes, int, error) {
	var t cpuTimes
	cores := 0
	found := false
	for _, line := range strings.Split(s, "\n") {
		f := strings.Fields(line)
		if len(f) == 0 {
			continue
		}
		if f[0] == "cpu" {
			// user nice system idle iowait irq softirq steal [guest guest_nice]
			// guest time is already counted inside user/nice, so stop at steal.
			if len(f) < 5 {
				return t, 0, fmt.Errorf("short cpu line: %q", line)
			}
			for i, v := range f[1:] {
				if i >= 8 {
					break
				}
				n, err := strconv.ParseUint(v, 10, 64)
				if err != nil {
					return t, 0, fmt.Errorf("cpu field %d: %w", i, err)
				}
				t.total += n
				if i != 3 && i != 4 { // idle, iowait
					t.busy += n
				}
			}
			found = true
		} else if strings.HasPrefix(f[0], "cpu") {
			cores++
		}
	}
	if !found {
		return t, 0, fmt.Errorf("no aggregate cpu line")
	}
	return t, cores, nil
}

// cpuPercent is the busy share of the interval between two samples.
func cpuPercent(prev, cur cpuTimes) float64 {
	if cur.total <= prev.total || cur.busy < prev.busy {
		return 0
	}
	return 100 * float64(cur.busy-prev.busy) / float64(cur.total-prev.total)
}

type memInfo struct{ total, avail, swapTotal, swapFree uint64 }

func parseMeminfo(s string) (memInfo, error) {
	var m memInfo
	seen := 0
	for _, line := range strings.Split(s, "\n") {
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		f := strings.Fields(v)
		if len(f) == 0 {
			continue
		}
		n, err := strconv.ParseUint(f[0], 10, 64)
		if err != nil {
			continue
		}
		n *= 1024 // kB
		switch k {
		case "MemTotal":
			m.total, seen = n, seen|1
		case "MemAvailable":
			m.avail, seen = n, seen|2
		case "SwapTotal":
			m.swapTotal = n
		case "SwapFree":
			m.swapFree = n
		}
	}
	if seen != 3 {
		return m, fmt.Errorf("meminfo lacks MemTotal/MemAvailable")
	}
	return m, nil
}

// parseNetDev sums bytes over every interface except loopback and the docker
// bridges/veths, whose traffic is the same bytes counted a second time.
func parseNetDev(s string) (rx, tx uint64) {
	for _, line := range strings.Split(s, "\n") {
		name, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		name = strings.TrimSpace(name)
		if name == "lo" || strings.HasPrefix(name, "veth") || strings.HasPrefix(name, "docker") || strings.HasPrefix(name, "br-") {
			continue
		}
		f := strings.Fields(rest)
		if len(f) < 9 {
			continue
		}
		r, _ := strconv.ParseUint(f[0], 10, 64)
		t, _ := strconv.ParseUint(f[8], 10, 64)
		rx += r
		tx += t
	}
	return rx, tx
}

// HostReader samples the host through its /proc and root filesystem, mounted
// read-only into the container (HOST_PROC, HOST_ROOT).
type HostReader struct {
	Proc string
	Root string

	prevCPU cpuTimes
	prevRx  uint64
	prevTx  uint64
	prevAt  time.Time
}

func (h *HostReader) read(name string) (string, error) {
	b, err := os.ReadFile(filepath.Join(h.Proc, name))
	return string(b), err
}

// Sample returns nil on the first call: CPU and network are rates, so they need
// a previous reading to difference against.
func (h *HostReader) Sample(now time.Time) (*wire.HostSample, error) {
	stat, err := h.read("stat")
	if err != nil {
		return nil, err
	}
	cpu, cores, err := parseProcStat(stat)
	if err != nil {
		return nil, err
	}
	mi, err := h.read("meminfo")
	if err != nil {
		return nil, err
	}
	mem, err := parseMeminfo(mi)
	if err != nil {
		return nil, err
	}
	// /proc/1/net/dev is the host's network namespace; /proc/net/dev would be
	// whichever namespace the reading process is in.
	nd, _ := h.read("1/net/dev")
	rx, tx := parseNetDev(nd)

	s := &wire.HostSample{
		TS:        now.UnixMilli(),
		Cores:     cores,
		MemTotal:  mem.total,
		MemUsed:   mem.total - min(mem.avail, mem.total),
		SwapTotal: mem.swapTotal,
		SwapUsed:  mem.swapTotal - min(mem.swapFree, mem.swapTotal),
	}
	if la, err := h.read("loadavg"); err == nil {
		f := strings.Fields(la)
		if len(f) >= 3 {
			s.Load1, _ = strconv.ParseFloat(f[0], 64)
			s.Load5, _ = strconv.ParseFloat(f[1], 64)
			s.Load15, _ = strconv.ParseFloat(f[2], 64)
		}
	}
	if up, err := h.read("uptime"); err == nil {
		if f := strings.Fields(up); len(f) > 0 {
			s.Uptime, _ = strconv.ParseFloat(f[0], 64)
		}
	}
	var fs syscall.Statfs_t
	if err := syscall.Statfs(h.Root, &fs); err == nil {
		bs := uint64(fs.Bsize)
		s.DiskTotal = fs.Blocks * bs
		s.DiskUsed = (fs.Blocks - fs.Bfree) * bs
	}

	first := h.prevAt.IsZero()
	if !first {
		s.CPU = cpuPercent(h.prevCPU, cpu)
		if dt := now.Sub(h.prevAt).Seconds(); dt > 0 && rx >= h.prevRx && tx >= h.prevTx {
			s.NetRx = float64(rx-h.prevRx) / dt
			s.NetTx = float64(tx-h.prevTx) / dt
		}
	}
	h.prevCPU, h.prevRx, h.prevTx, h.prevAt = cpu, rx, tx, now
	if first {
		return nil, nil
	}
	return s, nil
}

// readDeploy parses deploy/auto-update.sh's state file. Missing is not an error:
// a box without the timer simply has no deploy to report.
func readDeploy(path string) *wire.Deploy {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	d := &wire.Deploy{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "=")
		if !ok {
			continue
		}
		switch k {
		case "deployed_commit":
			d.Commit = v
		case "deployed_at":
			d.At = v
		}
	}
	if d.Commit == "" {
		return nil
	}
	return d
}
