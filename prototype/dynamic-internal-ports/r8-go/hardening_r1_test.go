package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func hardeningTestConfig() config {
	return config{
		Version: 1, Host: "example-go-hardening", ExpectedPublicHost: "example-go-hardening.test",
		StateRoot: "state", LogRoot: "logs", LogMaxBytes: 1024 * 1024, LogRetentionDays: 14,
		Listen: "127.0.0.1:19447", Upstream: "http://127.0.0.1:64239",
		ServiceIdentity:    `NT SERVICE\WinHelmGoTlsIngressHardeningR1`,
		CertRefreshSeconds: 21600, CertRefreshTimeoutSeconds: 60, CertFailClosedThresholdSeconds: 86400,
		CertRetryInitialSeconds: 10, CertRetryMaxSeconds: 300,
		TLSHandshakeTimeoutMS: 1000, ReadHeaderTimeoutMS: 1000, IdleTimeoutMS: 30000, MaxHeaderBytes: 16384,
		BodyReadTimeoutMS: 500, MCPBodyReadTimeoutMS: 5000,
		MetadataMaxBodyBytes: 0, OAuthFormMaxBodyBytes: 65536, TokenMaxBodyBytes: 262144, MCPMaxBodyBytes: 8388608,
		UpstreamDialTimeoutMS: 1000, UpstreamKeepAliveMS: 30000, UpstreamMaxIdleConns: 64,
		UpstreamMaxIdleConnsPerHost: 16, UpstreamMaxConnsPerHost: 32, UpstreamIdleConnTimeoutMS: 30000,
		UpstreamResponseHeaderTimeoutMS: 2000,
		StartupTimeoutMS:                5000, ControlPlaneTimeoutMS: 5000, CleanupTimeoutMS: 5000, ShutdownTimeoutMS: 5000,
	}
}

func writeHardeningConfig(t *testing.T, dir string, cfg config, extra map[string]any) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, "state"), 0700); err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if extra != nil {
		var fields map[string]any
		if err := json.Unmarshal(b, &fields); err != nil {
			t.Fatal(err)
		}
		for k, v := range extra {
			fields[k] = v
		}
		b, err = json.Marshal(fields)
		if err != nil {
			t.Fatal(err)
		}
	}
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestHardeningConfigRejectsUnknownFieldsAndBounds(t *testing.T) {
	dir := t.TempDir()
	cfg := hardeningTestConfig()
	path := writeHardeningConfig(t, dir, cfg, map[string]any{"unexpected": true})
	if _, _, _, err := loadConfig(path); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("unknown field accepted: %v", err)
	}

	cfg = hardeningTestConfig()
	cfg.MCPMaxBodyBytes = 0
	path = writeHardeningConfig(t, dir, cfg, nil)
	if _, _, _, err := loadConfig(path); err == nil {
		t.Fatal("zero MCP body limit accepted")
	}
}

func TestHardeningPinnedConfigLoads(t *testing.T) {
	cfg, resolved, upstream, err := loadConfig("config.json")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Listen != "127.0.0.1:19447" || upstream.String() != "http://127.0.0.1:64239" {
		t.Fatalf("isolation targets drifted: listen=%s upstream=%s", cfg.Listen, upstream)
	}
	if cfg.Host != "winhelm-gemini-go-hardening-01" || cfg.ServiceIdentity == "" {
		t.Fatalf("identity contract incomplete: host=%s service=%q", cfg.Host, cfg.ServiceIdentity)
	}
	if !pathWithin(filepath.Dir(resolved), cfg.StateRoot) || !pathWithin(filepath.Dir(resolved), cfg.LogRoot) {
		t.Fatal("config roots escaped candidate root")
	}
}

func TestHardeningAtomicStateMarkerReplacement(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "tailscaled.state"), []byte("state"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := writeStateMarker(dir, "example-go-hardening", "example-go-hardening.test"); err != nil {
		t.Fatal(err)
	}
	first, err := os.ReadFile(filepath.Join(dir, stateMarkerName))
	if err != nil {
		t.Fatal(err)
	}
	if err := writeStateMarker(dir, "example-go-hardening", "example-go-hardening.test"); err != nil {
		t.Fatal(err)
	}
	second, err := os.ReadFile(filepath.Join(dir, stateMarkerName))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first, second) {
		t.Fatalf("marker replacement changed stable bytes: %q != %q", first, second)
	}
	if err := validateStateMarker(dir, "example-go-hardening", "example-go-hardening.test"); err != nil {
		t.Fatal(err)
	}
}

func TestHardeningStateLockRejectsDuplicateOwner(t *testing.T) {
	dir := t.TempDir()
	first, err := acquireStateLock(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if _, err := acquireStateLock(dir); err == nil {
		t.Fatal("duplicate state owner accepted")
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := acquireStateLock(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := second.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestHardeningTLSStallDoesNotBlockEightLaterClients(t *testing.T) {
	now := time.Now()
	cert, roots := testCertificate(t, "example.test", now.Add(-time.Hour), now.Add(48*time.Hour))
	manager := newCertManager(&queueSource{results: []sourceResult{{cert: cert}}}, "example.test", roots, time.Second, time.Hour)
	if err := manager.refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	expectedSNI.Store("example.test")
	base, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	logger := newEventLogger(io.Discard)
	tracker := newConnTracker(logger)
	tlsListener := &observingTLSListener{Listener: base, config: newTLSConfig(manager), handshakeTimeout: time.Second, tracker: tracker}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }), ConnContext: tracker.connContext}
	go func() { _ = srv.Serve(tlsListener) }()
	t.Cleanup(func() {
		_ = srv.Shutdown(context.Background())
		_ = base.Close()
	})

	stalled, err := net.Dial("tcp", base.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer stalled.Close()
	start := time.Now()
	errCh := make(chan error, 8)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := tls.Dial("tcp", base.Addr().String(), &tls.Config{RootCAs: roots, ServerName: "example.test", MinVersion: tls.VersionTLS12, MaxVersion: tls.VersionTLS13, NextProtos: []string{"http/1.1"}})
			if err == nil {
				_ = c.Close()
			}
			errCh <- err
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			t.Fatal(err)
		}
	}
	if elapsed := time.Since(start); elapsed >= 400*time.Millisecond {
		t.Fatalf("later clients waited behind stalled handshake: %s", elapsed)
	}
}

func TestHardeningTLSStallTimesOutAndTrackerIsForgotten(t *testing.T) {
	now := time.Now()
	cert, roots := testCertificate(t, "example.test", now.Add(-time.Hour), now.Add(48*time.Hour))
	manager := newCertManager(&queueSource{results: []sourceResult{{cert: cert}}}, "example.test", roots, time.Second, time.Hour)
	if err := manager.refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	expectedSNI.Store("example.test")
	base, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	logger := newEventLogger(io.Discard)
	tracker := newConnTracker(logger)
	tlsListener := &observingTLSListener{Listener: base, config: newTLSConfig(manager), handshakeTimeout: 100 * time.Millisecond, tracker: tracker}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }), ConnContext: tracker.connContext}
	go func() { _ = srv.Serve(tlsListener) }()
	t.Cleanup(func() {
		_ = srv.Shutdown(context.Background())
		_ = base.Close()
	})
	peer, err := net.Dial("tcp", base.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	_ = peer.SetReadDeadline(time.Now().Add(time.Second))
	var b [1]byte
	if _, err := peer.Read(b[:]); err == nil {
		t.Fatal("stalled peer was not closed")
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		tracker.mu.Lock()
		remaining := len(tracker.metas)
		tracker.mu.Unlock()
		if remaining == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("failed handshake remained in tracker")
}

func TestHardeningBodyLimitsRejectBeforeUpstream(t *testing.T) {
	var calls atomic.Int32
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer backend.Close()
	u, _ := url.Parse(backend.URL)
	logger := newEventLogger(io.Discard)
	h := newProxy(u, logger, proxyOptions{bodyPolicies: defaultBodyPolicies(), bodyReadTimeout: time.Second})
	req := httptest.NewRequest(http.MethodPost, "https://example.test/oauth/token", strings.NewReader(strings.Repeat("x", 300000)))
	req.ContentLength = 300000
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status=%d body=%q", rr.Code, rr.Body.String())
	}
	if calls.Load() != 0 {
		t.Fatal("over-limit request reached upstream")
	}
}

type hardeningBlockingBody struct {
	once sync.Once
	done chan struct{}
}

func (b *hardeningBlockingBody) Read([]byte) (int, error) {
	<-b.done
	return 0, io.EOF
}

func (b *hardeningBlockingBody) Close() error {
	b.once.Do(func() { close(b.done) })
	return nil
}

func TestHardeningSlowBodyReturnsBoundedTimeout(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	defer backend.Close()
	u, _ := url.Parse(backend.URL)
	h := newProxy(u, newEventLogger(io.Discard), proxyOptions{bodyPolicies: defaultBodyPolicies(), bodyReadTimeout: 50 * time.Millisecond})
	body := &hardeningBlockingBody{done: make(chan struct{})}
	req := httptest.NewRequest(http.MethodPost, "https://example.test/oauth/token", body)
	req.ContentLength = -1
	rr := httptest.NewRecorder()
	start := time.Now()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusRequestTimeout {
		t.Fatalf("status=%d body=%q", rr.Code, rr.Body.String())
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("slow-body policy was not bounded: %s", elapsed)
	}
}

func TestHardeningDedicatedTransportBudgets(t *testing.T) {
	cfg := hardeningTestConfig()
	tr := newUpstreamTransport(cfg)
	if tr.DialContext == nil || tr.MaxConnsPerHost != cfg.UpstreamMaxConnsPerHost || tr.MaxIdleConns != cfg.UpstreamMaxIdleConns || tr.MaxIdleConnsPerHost != cfg.UpstreamMaxIdleConnsPerHost {
		t.Fatalf("transport limits not pinned: %#v", tr)
	}
	if tr.ResponseHeaderTimeout != 2*time.Second || tr.IdleConnTimeout != 30*time.Second {
		t.Fatalf("transport timeouts not pinned: header=%s idle=%s", tr.ResponseHeaderTimeout, tr.IdleConnTimeout)
	}
}

func TestHardeningUpstreamResponseHeaderTimeout(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(150 * time.Millisecond)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer backend.Close()
	u, _ := url.Parse(backend.URL)
	cfg := hardeningTestConfig()
	cfg.UpstreamResponseHeaderTimeoutMS = 50
	h := newProxy(u, newEventLogger(io.Discard), proxyOptions{transport: newUpstreamTransport(cfg), bodyPolicies: defaultBodyPolicies()})
	server := httptest.NewServer(h)
	defer server.Close()
	start := time.Now()
	resp, err := http.Get(server.URL + "/mcp")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	if time.Since(start) > time.Second {
		t.Fatal("response-header timeout was not bounded")
	}
}

func TestHardeningLongLivedMCPResponsePreserved(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("backend lacks flush support")
		}
		_, _ = io.WriteString(w, "first")
		flusher.Flush()
		time.Sleep(200 * time.Millisecond)
		_, _ = io.WriteString(w, "second")
	}))
	defer backend.Close()
	u, _ := url.Parse(backend.URL)
	server := httptest.NewServer(newProxy(u, newEventLogger(io.Discard), proxyOptions{bodyPolicies: defaultBodyPolicies()}))
	defer server.Close()
	resp, err := http.Get(server.URL + "/mcp")
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "firstsecond" {
		t.Fatalf("stream body=%q", body)
	}
}

type hardeningUncooperativeSource struct {
	calls   atomic.Int32
	release chan struct{}
	cert    *tls.Certificate
}

func (s *hardeningUncooperativeSource) Refresh(context.Context, string) (*tls.Certificate, error) {
	s.calls.Add(1)
	<-s.release
	return s.cert, nil
}

func TestHardeningCertificateRefreshSingleFlight(t *testing.T) {
	now := time.Now()
	cert, roots := testCertificate(t, "example.test", now.Add(-time.Hour), now.Add(48*time.Hour))
	src := &hardeningUncooperativeSource{release: make(chan struct{}), cert: cert}
	m := newCertManager(src, "example.test", roots, time.Second, time.Hour)
	firstDone := make(chan error, 1)
	go func() { firstDone <- m.refresh(context.Background()) }()
	time.Sleep(20 * time.Millisecond)
	secondCtx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if err := m.refresh(secondCtx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("second refresh err=%v", err)
	}
	if got := src.calls.Load(); got != 1 {
		t.Fatalf("overlapping refresh calls=%d", got)
	}
	close(src.release)
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}
	if err := m.refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := src.calls.Load(); got != 2 {
		t.Fatalf("refresh did not resume after prior completion: %d", got)
	}
}

func TestHardeningBackoffIsBoundedAndAccelerates(t *testing.T) {
	if got := retryDelay(10*time.Second, 5*time.Minute, 0); got != 10*time.Second {
		t.Fatalf("initial retry delay=%s", got)
	}
	if got := retryDelay(10*time.Second, 5*time.Minute, 3); got != 80*time.Second {
		t.Fatalf("retry delay=%s", got)
	}
	if got := retryDelay(10*time.Second, 5*time.Minute, 10); got != 5*time.Minute {
		t.Fatalf("retry max not enforced=%s", got)
	}
}

func TestHardeningACLSDDLFloorRejectsBroadWrite(t *testing.T) {
	if !sddlHasBroadWritablePrincipal(`D:(A;OICI;M;;;AU)(A;OICI;FA;;;SY)`) {
		t.Fatal("Authenticated Users modify ACE not rejected")
	}
	if !sddlHasBroadWritablePrincipal(`D:(A;OICI;GA;;;BU)(A;OICI;FA;;;SY)`) {
		t.Fatal("Users generic-all ACE not rejected")
	}
	if sddlHasBroadWritablePrincipal(`D:(A;OICI;RX;;;SY)(A;OICI;RX;;;BA)`) {
		t.Fatal("read/execute ACL rejected")
	}
}

func TestHardeningBoundedOperationClassifiesTimeout(t *testing.T) {
	start := time.Now()
	err := runBounded(context.Background(), 30*time.Millisecond, func(context.Context) error {
		time.Sleep(200 * time.Millisecond)
		return nil
	})
	if !errors.Is(err, errOperationTimeout) {
		t.Fatalf("err=%v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("bounded operation exceeded outer bound")
	}
}

func TestHardeningStartupOrderLocksBeforeTsnet(t *testing.T) {
	b, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	lock := strings.Index(s, "acquireStateLock(stateDir)")
	up := strings.Index(s, "srv.Up(startupCtx)")
	if lock < 0 || up < 0 || lock > up {
		t.Fatalf("state lock is not before tsnet startup: lock=%d up=%d", lock, up)
	}
	if strings.Contains(s, "lc.SetServeConfig(context.Background()") {
		t.Fatal("unbounded background ServeConfig cleanup remains")
	}
}

func TestHardeningPathRootContract(t *testing.T) {
	root := filepath.Clean(`C:\candidate`)
	if !pathWithin(root, filepath.Join(root, "state")) {
		t.Fatal("child path rejected")
	}
	if pathWithin(root, filepath.Join(root, "..", "outside")) {
		t.Fatal("path escape accepted")
	}
}

func TestHardeningRotatingLogWriter(t *testing.T) {
	w, err := newRotatingWriter(t.TempDir(), 1024*1024, 14)
	if err != nil {
		t.Fatal(err)
	}
	payload := bytes.Repeat([]byte("x"), 1024*1024)
	if _, err := w.Write(payload); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("next\n")); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(w.root, "winhelm-go-tls-ingress.jsonl.1")); err != nil {
		t.Fatal(err)
	}
}

func TestHardeningPrivacyFloorSuppressesHTTPRemoteErrors(t *testing.T) {
	b, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	if !strings.Contains(s, "ErrorLog:          log.New(io.Discard") {
		t.Fatal("http server error log is not explicitly suppressed")
	}
	for _, forbidden := range []string{"remote_address", "remote_port", "bearer", "private_key"} {
		if strings.Contains(s, `"`+forbidden+`"`) {
			t.Fatalf("privacy-forbidden event field present: %s", forbidden)
		}
	}
}

func TestHardeningServicePackageSeparatesLogin(t *testing.T) {
	service, err := os.ReadFile(filepath.Join("package", "install-service.ps1"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(service), "--login") {
		t.Fatal("normal service installer contains --login")
	}
	enroll, err := os.ReadFile(filepath.Join("package", "enroll.ps1"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(enroll), "--login") {
		t.Fatal("explicit enrollment action missing --login")
	}
}
