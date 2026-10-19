package main

import (
	"crypto/tls"
	"testing"
	"time"
)

func TestProductionALPNPolicy(t *testing.T) {
	now := time.Now()
	cert, roots := testCertificate(t, "example.test", now.Add(-time.Hour), now.Add(48*time.Hour))
	src := &queueSource{results: []sourceResult{{cert: cert}}}
	m := newCertManager(src, "example.test", roots, time.Second, time.Hour)
	if err := m.refresh(t.Context()); err != nil {
		t.Fatal(err)
	}
	cfg := newTLSConfig(m)

	allowNoALPN := &tls.ClientHelloInfo{ServerName: "example.test"}
	if _, err := cfg.GetConfigForClient(allowNoALPN); err != nil {
		t.Fatalf("no-ALPN baseline case rejected before adjudication: %v", err)
	}

	allowHTTP11 := &tls.ClientHelloInfo{ServerName: "example.test", SupportedProtos: []string{"http/1.1"}}
	if _, err := cfg.GetConfigForClient(allowHTTP11); err != nil {
		t.Fatalf("http/1.1 ALPN rejected: %v", err)
	}

	rejectUnknown := &tls.ClientHelloInfo{ServerName: "example.test", SupportedProtos: []string{"unknown/1"}}
	if _, err := cfg.GetConfigForClient(rejectUnknown); err == nil {
		t.Fatal("unknown-only ALPN unexpectedly accepted")
	}

	rejectH2Only := &tls.ClientHelloInfo{ServerName: "example.test", SupportedProtos: []string{"h2"}}
	if _, err := cfg.GetConfigForClient(rejectH2Only); err == nil {
		t.Fatal("h2-only ALPN unexpectedly accepted by http/1.1-only candidate")
	}
}
