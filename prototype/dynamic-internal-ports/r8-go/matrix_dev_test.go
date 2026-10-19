package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type matrixServer struct {
	addr    string
	roots   *x509.CertPool
	manager *certManager
	server  *http.Server
	backend *httptest.Server
}

func matrixTLSConfig(m *certManager) *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		CipherSuites: []uint16{
			tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
			tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
		},
		NextProtos:     []string{"http/1.1"},
		GetCertificate: m.getCertificate,
	}
}

func startMatrixServer(t *testing.T, readHeaderTimeout, idleTimeout time.Duration, maxHeaderBytes int, backendHandler http.Handler) *matrixServer {
	t.Helper()
	if backendHandler == nil {
		backendHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.Copy(io.Discard, r.Body)
			w.WriteHeader(http.StatusOK)
		})
	}
	backend := httptest.NewServer(backendHandler)
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
	expectedSNI.Store("example.test")
	base, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	logger := newEventLogger(io.Discard)
	tracker := newConnTracker(logger)
	tlsListener := &observingTLSListener{
		Listener:         base,
		config:           matrixTLSConfig(manager),
		handshakeTimeout: time.Second,
		tracker:          tracker,
	}
	srv := &http.Server{
		Handler:           newProxy(u, logger),
		ReadHeaderTimeout: readHeaderTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
		ConnContext:       tracker.connContext,
		ConnState: func(c net.Conn, state http.ConnState) {
			if state == http.StateClosed || state == http.StateHijacked {
				tracker.forget(c)
			}
		},
	}
	go func() {
		_ = srv.Serve(tlsListener)
	}()
	ms := &matrixServer{addr: base.Addr().String(), roots: roots, manager: manager, server: srv, backend: backend}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
		_ = base.Close()
		backend.Close()
	})
	return ms
}

func (m *matrixServer) client() *http.Client {
	tr := &http.Transport{
		TLSClientConfig: &tls.Config{
			RootCAs:    m.roots,
			ServerName: "example.test",
			MinVersion: tls.VersionTLS12,
			MaxVersion: tls.VersionTLS13,
			NextProtos: []string{"http/1.1"},
		},
		ForceAttemptHTTP2:   false,
		MaxIdleConns:        64,
		MaxIdleConnsPerHost: 64,
	}
	return &http.Client{Transport: tr, Timeout: 5 * time.Second}
}

func tlsDial(t *testing.T, m *matrixServer, minVersion, maxVersion uint16, serverName string, nextProtos []string) (*tls.Conn, error) {
	t.Helper()
	return tls.Dial("tcp", m.addr, &tls.Config{
		RootCAs:    m.roots,
		ServerName: serverName,
		MinVersion: minVersion,
		MaxVersion: maxVersion,
		NextProtos: nextProtos,
	})
}

func TestMatrixProtocolFloorTLS12TLS13AndTLS11Reject(t *testing.T) {
	m := startMatrixServer(t, time.Second, time.Second, 16384, nil)
	if c, err := tlsDial(t, m, tls.VersionTLS11, tls.VersionTLS11, "example.test", []string{"http/1.1"}); err == nil {
		c.Close()
		t.Fatal("TLS 1.1 unexpectedly accepted")
	}
	for _, tc := range []struct {
		name string
		v    uint16
	}{
		{"TLS12", tls.VersionTLS12},
		{"TLS13", tls.VersionTLS13},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, err := tlsDial(t, m, tc.v, tc.v, "example.test", []string{"http/1.1"})
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			if c.ConnectionState().Version != tc.v {
				t.Fatalf("version=%x want=%x", c.ConnectionState().Version, tc.v)
			}
		})
	}
	if c, err := tlsDial(t, m, tls.VersionTLS12, tls.VersionTLS13, "wrong.test", []string{"http/1.1"}); err == nil {
		c.Close()
		t.Fatal("SNI mismatch unexpectedly accepted")
	}
}

func TestMatrixALPNObservation(t *testing.T) {
	m := startMatrixServer(t, time.Second, time.Second, 16384, nil)
	c, err := tlsDial(t, m, tls.VersionTLS12, tls.VersionTLS13, "example.test", []string{"http/1.1"})
	if err != nil {
		t.Fatal(err)
	}
	if got := c.ConnectionState().NegotiatedProtocol; got != "http/1.1" {
		t.Fatalf("ALPN=%q", got)
	}
	c.Close()

	c2, err := tlsDial(t, m, tls.VersionTLS12, tls.VersionTLS13, "example.test", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := c2.ConnectionState().NegotiatedProtocol; got != "" {
		t.Fatalf("expected absent ALPN observation, got %q", got)
	}
	c2.Close()
}

func TestMatrixParallelTLSHandshakes(t *testing.T) {
	m := startMatrixServer(t, time.Second, time.Second, 16384, nil)
	const concurrency = 32
	const repetitions = 4
	errCh := make(chan error, concurrency)
	var wg sync.WaitGroup
	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < repetitions; j++ {
				c, err := tls.Dial("tcp", m.addr, &tls.Config{
					RootCAs:    m.roots,
					ServerName: "example.test",
					MinVersion: tls.VersionTLS12,
					MaxVersion: tls.VersionTLS13,
					NextProtos: []string{"http/1.1"},
				})
				if err != nil {
					errCh <- err
					return
				}
				_ = c.Close()
			}
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestMatrixParallelHTTPRequests(t *testing.T) {
	var count atomic.Int64
	m := startMatrixServer(t, time.Second, 2*time.Second, 16384, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		count.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	client := m.client()
	defer client.CloseIdleConnections()
	const total = 64
	const concurrency = 16
	sem := make(chan struct{}, concurrency)
	errCh := make(chan error, total)
	var wg sync.WaitGroup
	for i := 0; i < total; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			req, _ := http.NewRequest(http.MethodPost, "https://"+m.addr+"/mcp", strings.NewReader("x"))
			resp, err := client.Do(req)
			if err != nil {
				errCh <- err
				return
			}
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				errCh <- fmt.Errorf("status=%d", resp.StatusCode)
			}
		}()
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			t.Fatal(err)
		}
	}
	if got := count.Load(); got != total {
		t.Fatalf("backend count=%d want=%d", got, total)
	}
}

func TestMatrixKeepAliveReuse(t *testing.T) {
	m := startMatrixServer(t, time.Second, 2*time.Second, 16384, nil)
	client := m.client()
	defer client.CloseIdleConnections()
	reused := 0
	for i := 0; i < 10; i++ {
		req, _ := http.NewRequest(http.MethodGet, "https://"+m.addr+"/mcp", nil)
		trace := &httptrace.ClientTrace{GotConn: func(info httptrace.GotConnInfo) {
			if info.Reused {
				reused++
			}
		}}
		req = req.WithContext(httptrace.WithClientTrace(req.Context(), trace))
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}
	if reused < 8 {
		t.Fatalf("insufficient keep-alive reuse: %d", reused)
	}
}

func TestMatrixIdleTimeoutClosesIdleConnection(t *testing.T) {
	m := startMatrixServer(t, time.Second, 150*time.Millisecond, 16384, nil)
	client := m.client()
	defer client.CloseIdleConnections()
	do := func() bool {
		reused := false
		req, _ := http.NewRequest(http.MethodGet, "https://"+m.addr+"/mcp", nil)
		req = req.WithContext(httptrace.WithClientTrace(req.Context(), &httptrace.ClientTrace{GotConn: func(info httptrace.GotConnInfo) {
			reused = info.Reused
		}}))
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		return reused
	}
	_ = do()
	time.Sleep(400 * time.Millisecond)
	if reused := do(); reused {
		t.Fatal("connection was reused after idle timeout")
	}
}

func TestMatrixSlowHeadersTimeout(t *testing.T) {
	m := startMatrixServer(t, 150*time.Millisecond, time.Second, 16384, nil)
	c, err := tlsDial(t, m, tls.VersionTLS12, tls.VersionTLS13, "example.test", []string{"http/1.1"})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_, _ = io.WriteString(c, "GET /mcp HTTP/1.1\r\nHost: example.test\r\nX-Slow: ")
	time.Sleep(350 * time.Millisecond)
	_ = c.SetDeadline(time.Now().Add(time.Second))
	_, writeErr := io.WriteString(c, "done\r\n\r\n")
	line, readErr := bufio.NewReader(c).ReadString('\n')
	if writeErr == nil && readErr == nil && strings.Contains(line, " 200 ") {
		t.Fatalf("slow header unexpectedly accepted: %q", line)
	}
}

func TestMatrixOversizedHeadersRejected(t *testing.T) {
	m := startMatrixServer(t, time.Second, time.Second, 16384, nil)
	c, err := tlsDial(t, m, tls.VersionTLS12, tls.VersionTLS13, "example.test", []string{"http/1.1"})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	_, _ = io.WriteString(c, "GET /mcp HTTP/1.1\r\nHost: example.test\r\nX-Big: "+strings.Repeat("A", 20*1024)+"\r\n\r\n")
	line, err := bufio.NewReader(c).ReadString('\n')
	if err != nil {
		return
	}
	if !strings.Contains(line, "431") {
		t.Fatalf("expected 431 or close, got %q", line)
	}
}

func TestMatrixOversizedRequestStreams(t *testing.T) {
	const size = 8 * 1024 * 1024
	var got atomic.Int64
	m := startMatrixServer(t, 2*time.Second, 2*time.Second, 16384, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, _ := io.Copy(io.Discard, r.Body)
		got.Store(n)
		w.WriteHeader(http.StatusOK)
	}))
	client := m.client()
	defer client.CloseIdleConnections()
	body := bytes.NewReader(bytes.Repeat([]byte("x"), size))
	req, _ := http.NewRequest(http.MethodPost, "https://"+m.addr+"/mcp", body)
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	if got.Load() != size {
		t.Fatalf("backend bytes=%d want=%d", got.Load(), size)
	}
}

func TestMatrixAbruptDisconnectDoesNotPoisonServer(t *testing.T) {
	m := startMatrixServer(t, time.Second, time.Second, 16384, nil)
	c, err := tlsDial(t, m, tls.VersionTLS12, tls.VersionTLS13, "example.test", []string{"http/1.1"})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.WriteString(c, "POST /mcp HTTP/1.1\r\nHost: example.test\r\nContent-Length: 100000\r\n\r\npartial")
	_ = c.Close()

	client := m.client()
	defer client.CloseIdleConnections()
	resp, err := client.Get("https://" + m.addr + "/mcp")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("server unhealthy after abrupt disconnect: %d", resp.StatusCode)
	}
}

func TestMatrixMalformedHTTPRejected(t *testing.T) {
	m := startMatrixServer(t, time.Second, time.Second, 16384, nil)
	c, err := tlsDial(t, m, tls.VersionTLS12, tls.VersionTLS13, "example.test", []string{"http/1.1"})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	_, _ = io.WriteString(c, "THIS IS NOT HTTP\r\n\r\n")
	line, err := bufio.NewReader(c).ReadString('\n')
	if err != nil {
		return
	}
	if !strings.Contains(line, "400") {
		t.Fatalf("expected 400 or close, got %q", line)
	}
}

func TestMatrixUnknownRouteAndWrongMethodForwardSemantics(t *testing.T) {
	m := startMatrixServer(t, time.Second, time.Second, 16384, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/__unknown__" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.URL.Path == "/oauth/token" && r.Method == http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	client := m.client()
	defer client.CloseIdleConnections()
	resp, err := client.Get("https://" + m.addr + "/__unknown__")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown route status=%d", resp.StatusCode)
	}
	resp, err = client.Get("https://" + m.addr + "/oauth/token")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("wrong method status=%d", resp.StatusCode)
	}
}

func TestMatrixCertSourceDelayedSuccess(t *testing.T) {
	now := time.Now()
	cert, roots := testCertificate(t, "example.test", now.Add(-time.Hour), now.Add(48*time.Hour))
	src := &queueSource{results: []sourceResult{{cert: cert, delay: 50 * time.Millisecond}}}
	m := newCertManager(src, "example.test", roots, 500*time.Millisecond, time.Hour)
	if err := m.refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestMatrixRefreshDuringActiveHandshakesAndConcurrentSwap(t *testing.T) {
	m := startMatrixServer(t, time.Second, time.Second, 16384, nil)
	current := m.manager.state.Load()
	if current == nil {
		t.Fatal("missing initial certificate")
	}
	a := current.cert
	b := current.cert
	src := &cyclingSource{certs: []*tls.Certificate{&a, &b}}
	m.manager.source = src

	const handshakeWorkers = 16
	const handshakesEach = 20
	const swaps = 50
	var wg sync.WaitGroup
	errCh := make(chan error, handshakeWorkers+1)

	for i := 0; i < handshakeWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < handshakesEach; j++ {
				c, err := tls.Dial("tcp", m.addr, &tls.Config{
					RootCAs:    m.roots,
					ServerName: "example.test",
					MinVersion: tls.VersionTLS12,
					MaxVersion: tls.VersionTLS13,
					NextProtos: []string{"http/1.1"},
				})
				if err != nil {
					errCh <- err
					return
				}
				_ = c.Close()
			}
		}()
	}

	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < swaps; i++ {
			if err := m.manager.refresh(context.Background()); err != nil {
				errCh <- err
				return
			}
		}
	}()

	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil && !errors.Is(err, net.ErrClosed) {
			t.Fatal(err)
		}
	}
}
