// Package agent samples one host and pushes batches to the hub.
package agent

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/calstar/STAR/server-analytics/internal/wire"
)

type Config struct {
	Host           string // this box's name on the panel; must match its token's
	HubURL         string
	Token          string
	Proc           string // host /proc
	Root           string // host /
	Cgroup         string // host /sys/fs/cgroup
	DockerSock     string
	DeployState    string // deploy/auto-update.sh's state file
	JournalDir     string // "" disables journald logs
	JournalPrefix  []string
	SampleInterval time.Duration
	PushInterval   time.Duration
}

// How much an unreachable hub may cost the agent's memory. Past these the oldest
// data goes first: an outage leaves a gap, never an OOM.
const (
	maxBufferedAge  = 10 * time.Minute
	maxBufferedLogs = 5000
)

type Agent struct {
	cfg    Config
	host   *HostReader
	cts    *Containers
	dlogs  *DockerLogs
	jlogs  *JournalLogs
	client *http.Client

	pending wire.Batch
}

func New(cfg Config) *Agent {
	now := time.Now()
	dc := newDockerClient(cfg.DockerSock)
	return &Agent{
		cfg:    cfg,
		host:   &HostReader{Proc: cfg.Proc, Root: cfg.Root},
		cts:    &Containers{docker: dc, cgroup: cfg.Cgroup},
		dlogs:  &DockerLogs{docker: dc, started: now},
		jlogs:  &JournalLogs{Dir: cfg.JournalDir, Prefixes: cfg.JournalPrefix, started: now},
		client: &http.Client{Timeout: 20 * time.Second},
	}
}

func (a *Agent) sample(ctx context.Context, now time.Time) {
	if s, err := a.host.Sample(now); err != nil {
		log.Printf("host sample: %v", err)
	} else if s != nil {
		a.pending.Samples = append(a.pending.Samples, *s)
	}
	cs, err := a.cts.Sample(ctx, now)
	if err != nil {
		log.Printf("container sample: %v", err)
	}
	a.pending.Containers = append(a.pending.Containers, cs...)
}

func (a *Agent) collectLogs(ctx context.Context, now time.Time) {
	a.pending.Logs = append(a.pending.Logs, a.dlogs.Collect(ctx, a.cts)...)
	a.pending.Logs = append(a.pending.Logs, a.jlogs.Collect(ctx, now)...)
	a.pending.Deploy = readDeploy(a.cfg.DeployState)
}

// trim applies the buffer limits to whatever is still waiting to be sent.
func trim(b *wire.Batch, now time.Time) {
	cutoff := now.Add(-maxBufferedAge).UnixMilli()
	i := 0
	for i < len(b.Samples) && b.Samples[i].TS < cutoff {
		i++
	}
	b.Samples = b.Samples[i:]
	i = 0
	for i < len(b.Containers) && b.Containers[i].TS < cutoff {
		i++
	}
	b.Containers = b.Containers[i:]
	if n := len(b.Logs) - maxBufferedLogs; n > 0 {
		b.Logs = b.Logs[n:]
	}
}

func (a *Agent) push(ctx context.Context) error {
	b := a.pending
	b.Host = a.cfg.Host
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if err := json.NewEncoder(zw).Encode(b); err != nil {
		return err
	}
	if err := zw.Close(); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(a.cfg.HubURL, "/")+"/api/ingest", &buf)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set("Authorization", "Bearer "+a.cfg.Token)
	resp, err := a.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
		return fmt.Errorf("hub: %s: %s", resp.Status, bytes.TrimSpace(msg))
	}
	a.pending = wire.Batch{}
	return nil
}

func (a *Agent) Run(ctx context.Context) error {
	log.Printf("agent %q: pushing to %s every %s, sampling every %s", a.cfg.Host, a.cfg.HubURL, a.cfg.PushInterval, a.cfg.SampleInterval)
	sampleT := time.NewTicker(a.cfg.SampleInterval)
	pushT := time.NewTicker(a.cfg.PushInterval)
	defer sampleT.Stop()
	defer pushT.Stop()
	a.sample(ctx, time.Now())
	failing := false
	for {
		select {
		case <-ctx.Done():
			return nil
		case now := <-sampleT.C:
			a.sample(ctx, now)
		case now := <-pushT.C:
			a.collectLogs(ctx, now)
			trim(&a.pending, now)
			if err := a.push(ctx); err != nil {
				if !failing {
					log.Printf("push failed (buffering up to %s): %v", maxBufferedAge, err)
				}
				failing = true
			} else if failing {
				log.Printf("push recovered")
				failing = false
			}
		}
	}
}
