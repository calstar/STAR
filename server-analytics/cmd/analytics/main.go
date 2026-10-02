// analytics is STAR's server panel: `analytics agent` samples one box and pushes
// to the hub; `analytics hub` stores the pushes and serves the panel. One binary,
// one image, two roles. See server-analytics/README.md.
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/calstar/STAR/server-analytics/internal/agent"
	"github.com/calstar/STAR/server-analytics/internal/hub"
	"github.com/calstar/STAR/server-analytics/web"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func mustEnv(k string) string {
	v := os.Getenv(k)
	if v == "" {
		log.Fatalf("%s is required", k)
	}
	return v
}

func duration(k string, def time.Duration) time.Duration {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		log.Fatalf("%s=%q: want a positive duration like 15s", k, v)
	}
	return d
}

func list(v string) []string {
	var out []string
	for _, s := range strings.Split(v, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: analytics hub|agent")
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	switch os.Args[1] {
	case "hub":
		runHub(ctx)
	case "agent":
		runAgent(ctx)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q: want hub or agent\n", os.Args[1])
		os.Exit(2)
	}
}

func runHub(ctx context.Context) {
	// Unconfigured is not fatal: auto-update.sh treats a crash-looping container
	// as a failed deploy, so a hub that refused to start would block every later
	// EC2 deploy. It starts, refuses every push, and says why.
	tokens, err := hub.ParseTokens(os.Getenv("ANALYTICS_AGENT_TOKENS"))
	if err != nil {
		log.Printf("ANALYTICS_AGENT_TOKENS: %v", err)
		tokens = map[string]string{}
	}
	if len(tokens) == 0 {
		log.Printf("no agent tokens configured (ANALYTICS_AGENT_TOKENS): every push will be refused")
	}
	store, err := hub.Open(env("ANALYTICS_DB", "/data/analytics.db"))
	if err != nil {
		log.Fatal(err)
	}
	defer store.Close()

	// Who may view: STARProject's admins, fetched from STARProject itself. With
	// no STARPROJECT_URL (local dev only) DEV_ADMIN_EMAILS stands in.
	spURL := os.Getenv("STARPROJECT_URL")
	if spURL != "" && os.Getenv("STARPROJECT_INTERNAL_SECRET") == "" {
		log.Printf("STARPROJECT_INTERNAL_SECRET unset: STARProject will refuse the admin list, so nobody is admitted")
	}
	admins := hub.NewAdmins(spURL, os.Getenv("STARPROJECT_INTERNAL_SECRET"), list(os.Getenv("DEV_ADMIN_EMAILS")))
	if spURL == "" {
		log.Printf("STARPROJECT_URL unset: admitting only DEV_ADMIN_EMAILS (%d)", len(admins.Static))
	}

	go store.RunMaintenance(ctx, 10*time.Minute)

	srv := &http.Server{
		Addr: ":" + env("PORT", "8080"),
		Handler: (&hub.Server{
			Store: store, Tokens: tokens, Admins: admins,
			DevEmail: os.Getenv("DEV_AUTH_EMAIL"), UI: web.FS(),
		}).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shut, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(shut)
	}()
	log.Printf("hub listening on %s (%d agent tokens)", srv.Addr, len(tokens))
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func runAgent(ctx context.Context) {
	// Same reasoning as the hub: idle rather than crash-loop while unconfigured.
	if os.Getenv("ANALYTICS_TOKEN") == "" {
		log.Printf("ANALYTICS_TOKEN unset: not sampling or pushing until it is set")
		<-ctx.Done()
		return
	}
	cfg := agent.Config{
		Host:           mustEnv("HOST_NAME"),
		HubURL:         mustEnv("HUB_URL"),
		Token:          os.Getenv("ANALYTICS_TOKEN"),
		Proc:           env("HOST_PROC", "/host/proc"),
		Root:           env("HOST_ROOT", "/host/root"),
		Cgroup:         env("HOST_CGROUP", "/host/cgroup"),
		DockerSock:     env("DOCKER_SOCK", "/var/run/docker.sock"),
		DeployState:    env("DEPLOY_STATE", "/host/auto-update/state"),
		JournalDir:     os.Getenv("JOURNAL_DIR"),
		JournalPrefix:  list(env("JOURNAL_UNIT_PREFIXES", "sensor-")),
		SampleInterval: duration("SAMPLE_INTERVAL", 15*time.Second),
		PushInterval:   duration("PUSH_INTERVAL", 30*time.Second),
	}
	if err := agent.New(cfg).Run(ctx); err != nil {
		log.Fatal(err)
	}
}
