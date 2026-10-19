package main

import (
	"context"
	"crypto/tls"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestProductionTLSConfigSourcePins(t *testing.T) {
	b, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	required := []string{
		"MinVersion: tls.VersionTLS12",
		"tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256",
		"tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256",
		"tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384",
		"tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384",
		"tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256",
		"tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256",
		`NextProtos: []string{"http/1.1"}`,
		"GetCertificate: manager.getCertificate",
	}
	for _, needle := range required {
		if !strings.Contains(s, needle) {
			t.Fatalf("production TLS source pin missing: %s", needle)
		}
	}
	forbidden := []string{
		"tls.VersionTLS10",
		"tls.VersionTLS11",
		"TLS_RSA_WITH_3DES_EDE_CBC_SHA",
		"TLS_RSA_WITH_RC4_128_SHA",
	}
	for _, needle := range forbidden {
		if strings.Contains(s, needle) {
			t.Fatalf("forbidden TLS source indicator present: %s", needle)
		}
	}
}

type cyclingSource struct {
	mu    sync.Mutex
	certs []*tls.Certificate
	next  int
}

func (s *cyclingSource) Refresh(ctx context.Context, _ string) (*tls.Certificate, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.certs[s.next%len(s.certs)]
	s.next++
	return c, nil
}

func TestConcurrentSnapshotReadsDuringCertificateSwap(t *testing.T) {
	now := time.Date(2026, 10, 16, 0, 0, 0, 0, time.UTC)
	a, roots := testCertificate(t, "example.test", now.Add(-time.Hour), now.Add(72*time.Hour))
	bCopy := *a
	b := &bCopy
	src := &cyclingSource{certs: []*tls.Certificate{a, b}}
	m := newCertManager(src, "example.test", roots, time.Second, 24*time.Hour)
	m.now = func() time.Time { return now }
	if err := m.refresh(context.Background()); err != nil {
		t.Fatal(err)
	}

	const readers = 32
	const readsPerReader = 200
	const swaps = 100

	var wg sync.WaitGroup
	errCh := make(chan error, readers+1)

	for i := 0; i < readers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < readsPerReader; j++ {
				if _, err := m.getCertificate(&tls.ClientHelloInfo{ServerName: "example.test"}); err != nil {
					errCh <- err
					return
				}
			}
		}()
	}

	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < swaps; i++ {
			if err := m.refresh(context.Background()); err != nil {
				errCh <- err
				return
			}
		}
	}()

	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestALPNAbsenceIsObservablePolicyQuestion(t *testing.T) {
	// Phase A frozen Gemini windows included successful TLS handshakes with no
	// negotiated ALPN. Production source advertises http/1.1 but intentionally
	// does not reject ClientHello solely because ALPN is absent. The controlling
	// Phase B policy must adjudicate whether empty negotiated ALPN is allowed
	// before SPIKE_EXECUTION_STARTED.
	b, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	if !strings.Contains(s, `NextProtos: []string{"http/1.1"}`) {
		t.Fatal("http/1.1 ALPN advertisement missing")
	}
	if !strings.Contains(s, "SupportedProtos") {
		t.Fatal("ClientHello ALPN policy hook missing")
	}
}
