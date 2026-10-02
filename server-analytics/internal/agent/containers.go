package agent

import (
	"context"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/calstar/STAR/server-analytics/internal/wire"
)

// container is what the agent remembers about one container between samples.
type container struct {
	id, name, image string
	state, health   string
	restarts        int
	tty             bool
	memLimit        uint64

	prevCPU uint64 // cumulative CPU, microseconds
	prevAt  time.Time
}

// Containers samples every container on the host. The inventory (names, state,
// health, restart counts) comes from the Docker API once a minute; CPU and memory
// come from cgroup v2 files every sample, which is a file read where the Docker
// stats endpoint would block for about a second per container.
type Containers struct {
	docker   *dockerClient
	cgroup   string // host /sys/fs/cgroup, mounted read-only
	byID     map[string]*container
	listedAt time.Time
}

const inventoryEvery = 60 * time.Second

func (c *Containers) refresh(ctx context.Context, now time.Time) error {
	var list []dockerListEntry
	if err := c.docker.getJSON(ctx, "/containers/json", url.Values{"all": {"1"}}, &list); err != nil {
		return err
	}
	seen := make(map[string]*container, len(list))
	for _, e := range list {
		ct := c.byID[e.ID]
		if ct == nil {
			ct = &container{id: e.ID}
		}
		ct.image = e.Image
		ct.state = e.State
		if len(e.Names) > 0 {
			ct.name = strings.TrimPrefix(e.Names[0], "/")
		}
		var in dockerInspect
		if err := c.docker.getJSON(ctx, "/containers/"+e.ID+"/json", nil, &in); err == nil {
			ct.restarts = in.RestartCount
			ct.tty = in.Config.Tty
			ct.memLimit = uint64(max(in.HostConfig.Memory, 0))
			ct.health = ""
			if in.State.Health != nil {
				ct.health = in.State.Health.Status
			}
		}
		seen[e.ID] = ct
	}
	c.byID = seen
	c.listedAt = now
	return nil
}

// cgroupDir finds a container's cgroup under either Docker cgroup driver.
func (c *Containers) cgroupDir(id string) string {
	for _, p := range []string{
		filepath.Join(c.cgroup, "system.slice", "docker-"+id+".scope"), // systemd driver
		filepath.Join(c.cgroup, "docker", id),                          // cgroupfs driver
	} {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// readCgroup returns cumulative CPU in microseconds and memory in use, counted
// the way `docker stats` counts it (memory.current less inactive file cache).
func readCgroup(dir string) (cpuUsec, mem uint64, ok bool) {
	b, err := os.ReadFile(filepath.Join(dir, "cpu.stat"))
	if err != nil {
		return 0, 0, false
	}
	for _, line := range strings.Split(string(b), "\n") {
		if v, found := strings.CutPrefix(line, "usage_usec "); found {
			cpuUsec, _ = strconv.ParseUint(strings.TrimSpace(v), 10, 64)
		}
	}
	b, err = os.ReadFile(filepath.Join(dir, "memory.current"))
	if err != nil {
		return 0, 0, false
	}
	mem, _ = strconv.ParseUint(strings.TrimSpace(string(b)), 10, 64)
	if b, err := os.ReadFile(filepath.Join(dir, "memory.stat")); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if v, found := strings.CutPrefix(line, "inactive_file "); found {
				n, _ := strconv.ParseUint(strings.TrimSpace(v), 10, 64)
				if n < mem {
					mem -= n
				}
			}
		}
	}
	return cpuUsec, mem, true
}

// statsFallback asks the daemon when the cgroup files are not where either
// driver puts them (cgroup v1, or a host that did not mount /sys/fs/cgroup).
func (c *Containers) statsFallback(ctx context.Context, id string) (cpuUsec, mem, limit uint64, ok bool) {
	var s dockerStats
	q := url.Values{"stream": {"false"}, "one-shot": {"true"}}
	if err := c.docker.getJSON(ctx, "/containers/"+id+"/stats", q, &s); err != nil {
		return 0, 0, 0, false
	}
	mem = s.MemoryStats.Usage
	if n := s.MemoryStats.Stats["inactive_file"]; n < mem {
		mem -= n
	}
	return s.CPUStats.CPUUsage.TotalUsage / 1000, mem, s.MemoryStats.Limit, true
}

func (c *Containers) Sample(ctx context.Context, now time.Time) ([]wire.ContainerSample, error) {
	if c.byID == nil || now.Sub(c.listedAt) >= inventoryEvery {
		if err := c.refresh(ctx, now); err != nil {
			return nil, err
		}
	}
	out := make([]wire.ContainerSample, 0, len(c.byID))
	for _, ct := range c.byID {
		s := wire.ContainerSample{
			TS: now.UnixMilli(), Name: ct.name, Image: ct.image,
			State: ct.state, Health: ct.health, Restarts: ct.restarts, MemLimit: ct.memLimit,
		}
		if ct.state == "running" {
			var cpu, mem uint64
			var ok bool
			if dir := c.cgroupDir(ct.id); dir != "" {
				cpu, mem, ok = readCgroup(dir)
			}
			if !ok {
				var limit uint64
				cpu, mem, limit, ok = c.statsFallback(ctx, ct.id)
				if ok && s.MemLimit == 0 {
					s.MemLimit = limit
				}
			}
			if ok {
				s.MemUsed = mem
				if !ct.prevAt.IsZero() && cpu >= ct.prevCPU {
					if dt := now.Sub(ct.prevAt).Microseconds(); dt > 0 {
						s.CPU = 100 * float64(cpu-ct.prevCPU) / float64(dt)
					}
				}
				ct.prevCPU, ct.prevAt = cpu, now
			}
		} else {
			ct.prevAt = time.Time{}
		}
		out = append(out, s)
	}
	return out, nil
}

// running lists the containers whose logs are worth asking for.
func (c *Containers) running() []*container {
	var out []*container
	for _, ct := range c.byID {
		if ct.state == "running" || ct.state == "restarting" {
			out = append(out, ct)
		}
	}
	return out
}
