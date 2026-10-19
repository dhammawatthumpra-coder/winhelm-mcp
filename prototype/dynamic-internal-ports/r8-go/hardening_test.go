package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestForwardedClientMetadataSuppressed(t *testing.T) {
	type seen struct {
		Forwarded       string
		XForwardedFor   string
		XForwardedHost  string
		XForwardedProto string
	}
	ch := make(chan seen, 1)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ch <- seen{
			Forwarded:       r.Header.Get("Forwarded"),
			XForwardedFor:   r.Header.Get("X-Forwarded-For"),
			XForwardedHost:  r.Header.Get("X-Forwarded-Host"),
			XForwardedProto: r.Header.Get("X-Forwarded-Proto"),
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer backend.Close()
	u, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(newProxy(u, newEventLogger(io.Discard)))
	defer proxy.Close()

	req, err := http.NewRequest(http.MethodGet, proxy.URL+"/mcp", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Forwarded", "for=203.0.113.10;proto=https")
	req.Header.Set("X-Forwarded-For", "203.0.113.10")
	req.Header.Set("X-Forwarded-Host", "evil.example")
	req.Header.Set("X-Forwarded-Proto", "https")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	s := <-ch
	if s.Forwarded != "" || s.XForwardedFor != "" || s.XForwardedHost != "" || s.XForwardedProto != "" {
		t.Fatalf("forwarded metadata leaked upstream: %+v", s)
	}
}

func TestHTTP10RejectedBeforeProxy(t *testing.T) {
	var backendCalls int
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		backendCalls++
		w.WriteHeader(http.StatusOK)
	}))
	defer backend.Close()
	u, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}

	now := time.Now()
	cert, roots := testCertificate(t, "example.test", now.Add(-time.Hour), now.Add(48*time.Hour))
	src := &queueSource{results: []sourceResult{{cert: cert}}}
	manager := newCertManager(src, "example.test", roots, time.Second, time.Hour)
	if err := manager.refresh(context.Background()); err != nil {
		t.Fatal(err)
	}

	base, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer base.Close()
	expectedSNI.Store("example.test")
	logger := newEventLogger(io.Discard)
	tracker := newConnTracker(logger)
	tlsListener := &observingTLSListener{
		Listener:         base,
		config:           matrixTLSConfig(manager),
		handshakeTimeout: time.Second,
		tracker:          tracker,
	}
	srv := &http.Server{
		Handler:     newProxy(u, logger),
		ConnContext: tracker.connContext,
	}
	defer srv.Shutdown(context.Background())
	go srv.Serve(tlsListener)

	conn, err := tls.Dial("tcp", base.Addr().String(), &tls.Config{
		RootCAs:    roots,
		ServerName: "example.test",
		MinVersion: tls.VersionTLS12,
		MaxVersion: tls.VersionTLS13,
		NextProtos: []string{"http/1.1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := io.WriteString(conn, "GET /mcp HTTP/1.0\r\nHost: example.test\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(line, "505") {
		t.Fatalf("expected HTTP 505, got %q", line)
	}
	if backendCalls != 0 {
		t.Fatalf("HTTP/1.0 reached upstream: calls=%d", backendCalls)
	}
}
