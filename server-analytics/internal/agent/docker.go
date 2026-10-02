package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"
)

// dockerClient speaks the Engine API over the read-only-mounted unix socket.
// Only GETs: the agent never asks the daemon to change anything.
type dockerClient struct{ http *http.Client }

func newDockerClient(sock string) *dockerClient {
	return &dockerClient{http: &http.Client{
		Timeout: 20 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", sock)
			},
			MaxIdleConns: 2,
		},
	}}
}

func (d *dockerClient) get(ctx context.Context, path string, q url.Values) (*http.Response, error) {
	u := "http://docker" + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := d.http.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		resp.Body.Close()
		return nil, fmt.Errorf("docker %s: %s: %s", path, resp.Status, b)
	}
	return resp, nil
}

func (d *dockerClient) getJSON(ctx context.Context, path string, q url.Values, out any) error {
	resp, err := d.get(ctx, path, q)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return json.NewDecoder(resp.Body).Decode(out)
}

type dockerListEntry struct {
	ID    string   `json:"Id"`
	Names []string `json:"Names"`
	Image string   `json:"Image"`
	State string   `json:"State"`
}

type dockerInspect struct {
	RestartCount int `json:"RestartCount"`
	State        struct {
		Status string `json:"Status"`
		Health *struct {
			Status string `json:"Status"`
		} `json:"Health"`
	} `json:"State"`
	Config struct {
		Tty bool `json:"Tty"`
	} `json:"Config"`
	HostConfig struct {
		Memory int64 `json:"Memory"`
	} `json:"HostConfig"`
}

type dockerStats struct {
	CPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"` // ns
		} `json:"cpu_usage"`
	} `json:"cpu_stats"`
	MemoryStats struct {
		Usage uint64            `json:"usage"`
		Limit uint64            `json:"limit"`
		Stats map[string]uint64 `json:"stats"`
	} `json:"memory_stats"`
}
