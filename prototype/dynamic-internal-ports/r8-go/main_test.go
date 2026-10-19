package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

type goldenFile struct {
	Vectors []struct {
		ID               string `json:"id"`
		Target           string `json:"target"`
		ExpectedPathname string `json:"expected_pathname"`
		ExpectedClass    string `json:"expected_class"`
	} `json:"vectors"`
}

func TestRouteGoldenVectors(t *testing.T) {
	b, err := os.ReadFile("route-golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g goldenFile
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Vectors) != 20 {
		t.Fatalf("expected 20 vectors, got %d", len(g.Vectors))
	}
	for _, v := range g.Vectors {
		t.Run(v.ID, func(t *testing.T) {
			if got := nodePathname(v.Target); got != v.ExpectedPathname {
				t.Fatalf("pathname: got %q want %q", got, v.ExpectedPathname)
			}
			if got := classifyTarget(v.Target); got != v.ExpectedClass {
				t.Fatalf("class: got %q want %q", got, v.ExpectedClass)
			}
		})
	}
}

type sourceResult struct {
	cert  *tls.Certificate
	err   error
	delay time.Duration
}

type queueSource struct {
	mu      sync.Mutex
	results []sourceResult
}

func (s *queueSource) Refresh(ctx context.Context, _ string) (*tls.Certificate, error) {
	s.mu.Lock()
	if len(s.results) == 0 {
		s.mu.Unlock()
		return nil, context.Canceled
	}
	r := s.results[0]
	s.results = s.results[1:]
	s.mu.Unlock()
	if r.delay > 0 {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(r.delay):
		}
	}
	return r.cert, r.err
}

func testCertificate(t *testing.T, dns string, notBefore, notAfter time.Time) (*tls.Certificate, *x509.CertPool) {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "test-ca"},
		NotBefore:             notBefore.Add(-time.Hour),
		NotAfter:              notAfter.Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leafTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(notAfter.UnixNano()),
		Subject:      pkix.Name{CommonName: dns},
		DNSNames:     []string{dns},
		NotBefore:    notBefore,
		NotAfter:     notAfter,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTmpl, caCert, &leafKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(caCert)
	cert := &tls.Certificate{
		Certificate: [][]byte{leafDER, caDER},
		PrivateKey:  leafKey,
	}
	return cert, roots
}

func TestCertManagerTransientFailureOutsideThreshold(t *testing.T) {
	now := time.Date(2026, 10, 16, 0, 0, 0, 0, time.UTC)
	cert, roots := testCertificate(t, "example.test", now.Add(-time.Hour), now.Add(72*time.Hour))
	src := &queueSource{results: []sourceResult{{cert: cert}, {err: context.DeadlineExceeded}}}
	m := newCertManager(src, "example.test", roots, time.Second, 24*time.Hour)
	m.now = func() time.Time { return now }
	if err := m.refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := m.refresh(context.Background()); err == nil {
		t.Fatal("expected refresh failure")
	}
	if _, err := m.getCertificate(&tls.ClientHelloInfo{ServerName: "example.test"}); err != nil {
		t.Fatalf("valid current cert should remain usable outside threshold: %v", err)
	}
}

func TestCertManagerFailureInsideThresholdFailsClosed(t *testing.T) {
	now := time.Date(2026, 10, 16, 0, 0, 0, 0, time.UTC)
	cert, roots := testCertificate(t, "example.test", now.Add(-time.Hour), now.Add(2*time.Hour))
	src := &queueSource{results: []sourceResult{{cert: cert}, {err: context.DeadlineExceeded}}}
	m := newCertManager(src, "example.test", roots, time.Second, 24*time.Hour)
	m.now = func() time.Time { return now }
	if err := m.refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := m.refresh(context.Background()); err == nil {
		t.Fatal("expected refresh failure")
	}
	if _, err := m.getCertificate(&tls.ClientHelloInfo{ServerName: "example.test"}); err == nil {
		t.Fatal("expected fail closed inside threshold after refresh failure")
	}
}

func TestCertManagerStartupFailureHasNoSnapshot(t *testing.T) {
	src := &queueSource{results: []sourceResult{{err: context.DeadlineExceeded}}}
	m := newCertManager(src, "example.test", nil, time.Second, time.Hour)
	if err := m.refresh(context.Background()); err == nil {
		t.Fatal("expected initial refresh failure")
	}
	if _, err := m.getCertificate(&tls.ClientHelloInfo{ServerName: "example.test"}); err == nil {
		t.Fatal("expected no certificate snapshot")
	}
}

func TestCertManagerRefreshTimeout(t *testing.T) {
	now := time.Now()
	cert, roots := testCertificate(t, "example.test", now.Add(-time.Hour), now.Add(48*time.Hour))
	src := &queueSource{results: []sourceResult{{cert: cert, delay: 100 * time.Millisecond}}}
	m := newCertManager(src, "example.test", roots, 10*time.Millisecond, time.Hour)
	if err := m.refresh(context.Background()); err == nil {
		t.Fatal("expected timeout")
	}
}

func TestMalformedReplacementDoesNotReplaceValidSnapshot(t *testing.T) {
	now := time.Date(2026, 10, 16, 0, 0, 0, 0, time.UTC)
	good, roots := testCertificate(t, "example.test", now.Add(-time.Hour), now.Add(72*time.Hour))
	bad := &tls.Certificate{Certificate: [][]byte{[]byte("not-a-certificate")}, PrivateKey: good.PrivateKey}
	src := &queueSource{results: []sourceResult{{cert: good}, {cert: bad}}}
	m := newCertManager(src, "example.test", roots, time.Second, 24*time.Hour)
	m.now = func() time.Time { return now }
	if err := m.refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	before := m.state.Load().leaf.SerialNumber.String()
	if err := m.refresh(context.Background()); err == nil {
		t.Fatal("expected malformed replacement rejection")
	}
	after := m.state.Load().leaf.SerialNumber.String()
	if before != after {
		t.Fatalf("snapshot changed: before=%s after=%s", before, after)
	}
	if _, err := m.getCertificate(&tls.ClientHelloInfo{ServerName: "example.test"}); err != nil {
		t.Fatalf("old valid snapshot should remain usable: %v", err)
	}
}

func TestExpiredReplacementDoesNotReplaceValidSnapshot(t *testing.T) {
	now := time.Date(2026, 10, 16, 0, 0, 0, 0, time.UTC)
	good, roots := testCertificate(t, "example.test", now.Add(-time.Hour), now.Add(72*time.Hour))
	expired, _ := testCertificate(t, "example.test", now.Add(-72*time.Hour), now.Add(-time.Hour))
	src := &queueSource{results: []sourceResult{{cert: good}, {cert: expired}}}
	m := newCertManager(src, "example.test", roots, time.Second, 24*time.Hour)
	m.now = func() time.Time { return now }
	if err := m.refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	before := m.state.Load().leaf.SerialNumber.String()
	if err := m.refresh(context.Background()); err == nil {
		t.Fatal("expected expired replacement rejection")
	}
	after := m.state.Load().leaf.SerialNumber.String()
	if before != after {
		t.Fatal("expired certificate replaced valid snapshot")
	}
}

func TestSNIMismatchFailsClosed(t *testing.T) {
	now := time.Now()
	cert, roots := testCertificate(t, "example.test", now.Add(-time.Hour), now.Add(48*time.Hour))
	src := &queueSource{results: []sourceResult{{cert: cert}}}
	m := newCertManager(src, "example.test", roots, time.Second, time.Hour)
	if err := m.refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := m.getCertificate(&tls.ClientHelloInfo{ServerName: "wrong.test"}); err == nil {
		t.Fatal("expected SNI mismatch")
	}
}

func TestProxyPreservesTargetAndStripsHopHeaders(t *testing.T) {
	type seen struct {
		Host       string
		RequestURI string
		Connection string
		Custom     string
	}
	ch := make(chan seen, 1)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ch <- seen{
			Host:       r.Host,
			RequestURI: r.RequestURI,
			Connection: r.Header.Get("Connection"),
			Custom:     r.Header.Get("X-Test"),
		}
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Backend", "ok")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, "ok")
	}))
	defer backend.Close()
	u, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}
	proxy := httptest.NewServer(newProxy(u, newEventLogger(io.Discard)))
	defer proxy.Close()

	req, err := http.NewRequest(http.MethodPost, proxy.URL+"/mcp%2Fextra?x=1", strings.NewReader("abc"))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Connection", "keep-alive")
	req.Header.Set("Proxy-Connection", "keep-alive")
	req.Header.Set("X-Test", "value")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	if got := resp.Header.Get("Connection"); got != "" {
		t.Fatalf("hop response header leaked: %q", got)
	}
	s := <-ch
	if s.Host != u.Host {
		t.Fatalf("host=%q want %q", s.Host, u.Host)
	}
	if s.RequestURI != "/mcp%2Fextra?x=1" {
		t.Fatalf("request URI changed: %q", s.RequestURI)
	}
	if s.Connection != "" {
		t.Fatalf("hop request header leaked: %q", s.Connection)
	}
	if s.Custom != "value" {
		t.Fatalf("custom header lost: %q", s.Custom)
	}
}
