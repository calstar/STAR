package hub

import (
	"compress/gzip"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/calstar/STAR/server-analytics/internal/wire"
)

// maxBatchBytes bounds a decompressed push. A full batch is well under 2 MB; the
// limit is what stops a small gzip body inflating without end.
const maxBatchBytes = 16 << 20

// ParseTokens reads ANALYTICS_AGENT_TOKENS: "host:token,host:token". Each token
// is bound to one host, so the apps box's token cannot write as ec2. An entry
// with an empty token is a host not set up yet and is skipped; a short one is
// an error.
func ParseTokens(s string) (map[string]string, error) {
	out := map[string]string{} // token -> host
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		host, tok, ok := strings.Cut(part, ":")
		host, tok = strings.TrimSpace(host), strings.TrimSpace(tok)
		if ok && host != "" && tok == "" {
			continue
		}
		if !ok || host == "" || len(tok) < 16 {
			return nil, fmt.Errorf("agent token entry %q: want host:token with a token of 16+ characters", part)
		}
		out[tok] = host
	}
	return out, nil
}

// hostForToken compares against every token in constant time, so the response
// time says nothing about how much of a guess was right.
func hostForToken(tokens map[string]string, got string) string {
	host := ""
	for tok, h := range tokens {
		if subtle.ConstantTimeCompare([]byte(tok), []byte(got)) == 1 {
			host = h
		}
	}
	return host
}

func (s *Server) handleIngest(w http.ResponseWriter, r *http.Request) {
	bearer, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	host := ""
	if ok {
		host = hostForToken(s.Tokens, bearer)
	}
	if host == "" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var body io.Reader = r.Body
	if r.Header.Get("Content-Encoding") == "gzip" {
		zr, err := gzip.NewReader(r.Body)
		if err != nil {
			http.Error(w, "bad gzip", http.StatusBadRequest)
			return
		}
		defer zr.Close()
		body = zr
	}
	var b wire.Batch
	dec := json.NewDecoder(io.LimitReader(body, maxBatchBytes))
	if err := dec.Decode(&b); err != nil {
		http.Error(w, "bad batch: "+err.Error(), http.StatusBadRequest)
		return
	}
	if b.Host != host {
		http.Error(w, fmt.Sprintf("this token writes as %q, not %q", host, b.Host), http.StatusForbidden)
		return
	}
	now := time.Now()
	dropFuture(&b, now)
	if err := s.Store.Ingest(&b, now.UnixMilli()); err != nil {
		log.Printf("ingest %s: %v", host, err)
		http.Error(w, "store failed", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// dropFuture discards rows stamped well ahead of the hub's clock. A host with a
// wrong clock would otherwise plant points the charts keep showing as "latest".
func dropFuture(b *wire.Batch, now time.Time) {
	limit := now.Add(5 * time.Minute).UnixMilli()
	samples := b.Samples[:0]
	for _, x := range b.Samples {
		if x.TS <= limit {
			samples = append(samples, x)
		}
	}
	b.Samples = samples
	cs := b.Containers[:0]
	for _, x := range b.Containers {
		if x.TS <= limit {
			cs = append(cs, x)
		}
	}
	b.Containers = cs
	ls := b.Logs[:0]
	for _, x := range b.Logs {
		if x.TS <= limit {
			ls = append(ls, x)
		}
	}
	b.Logs = ls
}
