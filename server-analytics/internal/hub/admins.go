package hub

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Admins decides who may view the panel. The answer is STARProject's admin list:
// its seed admins less any removed in its UI, plus any added there
// (starproject/src/lib/admins.ts). One list, managed in one place.
//
// The hub asks STARProject over the compose network and caches the answer. If
// STARProject cannot be reached, the last good list is honoured for staleFor,
// then nobody is admitted. Failing closed is the right direction for a page that
// shows both boxes' logs.
type Admins struct {
	URL    string // e.g. http://starproject:3000; "" means use Static
	Secret string
	Static []string // dev only, used when URL is empty

	client   *http.Client
	mu       sync.Mutex
	emails   map[string]bool
	fetched  time.Time
	attempt  time.Time
	refresh  time.Duration
	staleFor time.Duration
}

func NewAdmins(url, secret string, static []string) *Admins {
	return &Admins{
		URL: strings.TrimRight(url, "/"), Secret: secret, Static: static,
		client:  &http.Client{Timeout: 5 * time.Second},
		refresh: time.Minute, staleFor: 10 * time.Minute,
	}
}

func (a *Admins) fetch(ctx context.Context) (map[string]bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.URL+"/api/internal/admins", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Internal-Secret", a.Secret)
	resp, err := a.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("starproject admins: %s", resp.Status)
	}
	var body struct {
		Emails []string `json:"emails"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, err
	}
	m := make(map[string]bool, len(body.Emails))
	for _, e := range body.Emails {
		m[strings.ToLower(strings.TrimSpace(e))] = true
	}
	return m, nil
}

func (a *Admins) IsAdmin(ctx context.Context, email string) bool {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return false
	}
	if a.URL == "" {
		for _, e := range a.Static {
			if strings.EqualFold(strings.TrimSpace(e), email) {
				return true
			}
		}
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	now := time.Now()
	// Retry at most every few seconds, so an outage does not turn every panel
	// poll into a 5 s wait on STARProject.
	if now.Sub(a.fetched) >= a.refresh && now.Sub(a.attempt) >= 5*time.Second {
		a.attempt = now
		if m, err := a.fetch(ctx); err == nil {
			a.emails, a.fetched = m, now
		}
	}
	if a.emails == nil || now.Sub(a.fetched) > a.staleFor {
		return false
	}
	return a.emails[email]
}
