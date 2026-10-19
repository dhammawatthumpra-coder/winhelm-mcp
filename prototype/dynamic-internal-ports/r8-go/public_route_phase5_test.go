package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPhase5DynamicActivationUsesFreshVerifiedR8TargetOnPublic443(t *testing.T) {
	events := &bytes.Buffer{}
	client := &fakeServeClient{}
	ctrl := newPublicRouteController(client, prTestHost, "127.0.0.1:62041", time.Second, newEventLogger(events))
	calls := 0
	ctrl.verifyRouteTarget = func(context.Context) (routeTargetIdentity, error) {
		calls++
		return routeTargetIdentity{
			Listen:     "127.0.0.1:62041",
			Generation: "11111111-1111-4111-8111-111111111111",
			PID:        4242,
		}, nil
	}

	if err := ctrl.activate(context.Background(), "0123456789abcdef0123456789abcdef"); err != nil {
		t.Fatalf("activate: %v", err)
	}
	if calls != 2 {
		t.Fatalf("expected pre/post activation verification, got %d", calls)
	}
	if client.cfg == nil || !client.cfg.AllowFunnel[ctrl.routeHostPort()] {
		t.Fatal("public funnel 443 was not activated")
	}
	h := client.cfg.TCP[publicRoutePort]
	if h == nil || h.TCPForward != "127.0.0.1:62041" {
		t.Fatalf("unexpected dynamic public target: %+v", h)
	}
	target, ok := ctrl.lastVerifiedTarget()
	if !ok || target.Generation != "11111111-1111-4111-8111-111111111111" || target.PID != 4242 {
		t.Fatalf("verified target identity was not retained for status: %+v ok=%v", target, ok)
	}
}

func TestPhase5StaleR8TargetRefusesActivationBeforeServeConfigMutation(t *testing.T) {
	client := &fakeServeClient{}
	ctrl := newPublicRouteController(client, prTestHost, "127.0.0.1:62042", time.Second, newEventLogger(&bytes.Buffer{}))
	ctrl.verifyRouteTarget = func(context.Context) (routeTargetIdentity, error) {
		return routeTargetIdentity{}, errRouteTargetUnverified
	}

	err := ctrl.activate(context.Background(), "1123456789abcdef0123456789abcdef")
	if !errors.Is(err, errRouteTargetUnverified) {
		t.Fatalf("expected unverified target refusal, got %v", err)
	}
	if client.setCount() != 0 {
		t.Fatal("serve config mutated despite stale/unverified R8 target")
	}
}

func TestPhase5EveryActivationAttemptReverifiesGeneration(t *testing.T) {
	client := &fakeServeClient{}
	ctrl := newPublicRouteController(client, prTestHost, "127.0.0.1:62043", time.Second, newEventLogger(&bytes.Buffer{}))
	calls := 0
	ctrl.verifyRouteTarget = func(context.Context) (routeTargetIdentity, error) {
		calls++
		if calls <= 2 {
			return routeTargetIdentity{
				Listen:     "127.0.0.1:62043",
				Generation: "22222222-2222-4222-8222-222222222222",
				PID:        4343,
			}, nil
		}
		return routeTargetIdentity{}, errRouteTargetUnverified
	}

	if err := ctrl.activate(context.Background(), "2123456789abcdef0123456789abcdef"); err != nil {
		t.Fatalf("first activation: %v", err)
	}
	before := client.setCount()
	err := ctrl.activate(context.Background(), "3123456789abcdef0123456789abcdef")
	if !errors.Is(err, errRouteTargetUnverified) {
		t.Fatalf("second activation should require fresh verification, got %v", err)
	}
	if client.setCount() != before {
		t.Fatal("second activation mutated serve config after generation verification failed")
	}
	if calls != 3 {
		t.Fatalf("expected pre/post verification for success and fresh verification for retry, calls=%d", calls)
	}
}

func TestPhase5TargetChangeAfterApplyClearsPublicRouteFailClosed(t *testing.T) {
	client := &fakeServeClient{}
	ctrl := newPublicRouteController(client, prTestHost, "127.0.0.1:62047", time.Second, newEventLogger(&bytes.Buffer{}))
	calls := 0
	ctrl.verifyRouteTarget = func(context.Context) (routeTargetIdentity, error) {
		calls++
		if calls == 1 {
			return routeTargetIdentity{
				Listen:     "127.0.0.1:62047",
				Generation: "88888888-8888-4888-8888-888888888888",
				PID:        4747,
			}, nil
		}
		return routeTargetIdentity{
			Listen:     "127.0.0.1:62047",
			Generation: "99999999-9999-4999-8999-999999999999",
			PID:        4747,
		}, nil
	}

	err := ctrl.activate(context.Background(), "7123456789abcdef0123456789abcdef")
	if !errors.Is(err, errRouteTargetChanged) {
		t.Fatalf("expected target-change refusal, got %v", err)
	}
	if client.cfg == nil {
		t.Fatal("expected fail-closed cleanup write")
	}
	if ctrl.routeActive(client.cfg) {
		t.Fatal("public route remained active after target identity changed")
	}
	if client.setCount() < 2 {
		t.Fatalf("expected apply followed by cleanup, setCalls=%d", client.setCount())
	}
}

func TestPhase5RuntimeRegistryMustMatchCurrentGenerationPIDExecutableAndListener(t *testing.T) {
	dir := t.TempDir()
	registry := filepath.Join(dir, "r8.json")
	exe := filepath.Join(dir, "winhelm-r8.exe")
	record := runtimeRouteEndpointRecord{
		SchemaVersion:    1,
		Role:             "r8",
		Generation:       "33333333-3333-4333-8333-333333333333",
		State:            "ready",
		Host:             "127.0.0.1",
		Port:             62044,
		PID:              4444,
		ProcessCreatedAt: "2026-10-18T10:00:00.000Z",
		ExecutablePath:   exe,
		EntrypointPath:   exe,
		PublishedAt:      "2026-10-18T10:00:01.000Z",
	}
	b, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(registry, append(b, '\n'), 0600); err != nil {
		t.Fatal(err)
	}

	probes := 0
	target, err := verifyCurrentR8RouteTarget(context.Background(), routeTargetVerificationOptions{
		RegistryPath:       registry,
		Generation:         record.Generation,
		PID:                record.PID,
		Listen:             "127.0.0.1:62044",
		ExpectedExecutable: exe,
		PublicHost:         "example.test",
		ProbeTLSHealth: func(context.Context, string, string, string, int) error {
			probes++
			return nil
		},
	})
	if err != nil {
		t.Fatalf("verify current target: %v", err)
	}
	if target.Listen != "127.0.0.1:62044" || target.Generation != record.Generation || target.PID != record.PID || probes != 1 {
		t.Fatalf("unexpected target/probe result: %+v probes=%d", target, probes)
	}

	for name, mutate := range map[string]func(*routeTargetVerificationOptions){
		"generation": func(o *routeTargetVerificationOptions) { o.Generation = "44444444-4444-4444-8444-444444444444" },
		"pid":        func(o *routeTargetVerificationOptions) { o.PID++ },
		"listener":   func(o *routeTargetVerificationOptions) { o.Listen = "127.0.0.1:62045" },
		"executable": func(o *routeTargetVerificationOptions) { o.ExpectedExecutable += ".other" },
	} {
		t.Run(name, func(t *testing.T) {
			opts := routeTargetVerificationOptions{
				RegistryPath:       registry,
				Generation:         record.Generation,
				PID:                record.PID,
				Listen:             "127.0.0.1:62044",
				ExpectedExecutable: exe,
				PublicHost:         "example.test",
				ProbeTLSHealth: func(context.Context, string, string, string, int) error {
					t.Fatal("health probe must not run for identity mismatch")
					return nil
				},
			}
			mutate(&opts)
			if _, err := verifyCurrentR8RouteTarget(context.Background(), opts); !errors.Is(err, errRouteTargetUnverified) {
				t.Fatalf("expected fail-closed mismatch, got %v", err)
			}
		})
	}
}

func TestPhase5ControlStatusShowsPublicAndVerifiedInternalTargetIdentity(t *testing.T) {
	dir := t.TempDir()
	ctrl := newPublicRouteController(&fakeServeClient{}, prTestHost, "127.0.0.1:62046", time.Second, newEventLogger(&bytes.Buffer{}))
	ctrl.setLastVerifiedTarget(routeTargetIdentity{
		Listen:     "127.0.0.1:62046",
		Generation: "55555555-5555-4555-8555-555555555555",
		PID:        4646,
	})
	cc := newControlChannel(dir, winhelmServiceName, prTestHost, "127.0.0.1:62046", ctrl, newEventLogger(&bytes.Buffer{}))
	cc.publicRoute = "active"
	if err := cc.writeStatus(); err != nil {
		t.Fatalf("write status: %v", err)
	}
	raw, err := os.ReadFile(cc.statusPath())
	if err != nil {
		t.Fatal(err)
	}
	var status controlStatus
	if err := json.Unmarshal(raw, &status); err != nil {
		t.Fatal(err)
	}
	if status.PublicPort != 443 || status.PublicHost != prTestHost {
		t.Fatalf("public identity drifted: %+v", status)
	}
	if status.InternalTarget == nil ||
		status.InternalTarget.Listener != "127.0.0.1:62046" ||
		status.InternalTarget.Generation != "55555555-5555-4555-8555-555555555555" ||
		status.InternalTarget.PID != 4646 ||
		status.InternalTarget.Verification != "verified_at_activation" {
		t.Fatalf("internal target identity missing: %+v", status.InternalTarget)
	}
}

func TestPhase5TLSHealthProbeRequiresTrustedSNIAndGenerationPID(t *testing.T) {
	generation := "66666666-6666-4666-8666-666666666666"
	pid := 4848
	now := time.Now()
	cert, roots := testCertificate(t, "example.test", now.Add(-time.Hour), now.Add(time.Hour))

	base, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{
		Handler: runtimeHealthHandler(http.NotFoundHandler(), generation, pid),
	}
	tlsListener := tls.NewListener(base, &tls.Config{
		Certificates: []tls.Certificate{*cert},
		MinVersion:   tls.VersionTLS12,
	})
	done := make(chan error, 1)
	go func() {
		err := server.Serve(tlsListener)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		done <- err
	}()
	t.Cleanup(func() {
		_ = server.Shutdown(context.Background())
		<-done
	})

	listen := base.Addr().String()
	if err := probeR8RouteTLSHealthWithRoots(
		context.Background(),
		listen,
		"example.test",
		generation,
		pid,
		roots,
	); err != nil {
		t.Fatalf("trusted SNI/generation/PID probe failed: %v", err)
	}

	if err := probeR8RouteTLSHealthWithRoots(
		context.Background(),
		listen,
		"wrong.example.test",
		generation,
		pid,
		roots,
	); !errors.Is(err, errRouteTargetUnverified) {
		t.Fatalf("wrong SNI must fail closed, got %v", err)
	}

	if err := probeR8RouteTLSHealthWithRoots(
		context.Background(),
		listen,
		"example.test",
		"77777777-7777-4777-8777-777777777777",
		pid,
		roots,
	); !errors.Is(err, errRouteTargetUnverified) {
		t.Fatalf("wrong generation must fail closed, got %v", err)
	}

	if err := probeR8RouteTLSHealthWithRoots(
		context.Background(),
		listen,
		"example.test",
		generation,
		pid+1,
		roots,
	); !errors.Is(err, errRouteTargetUnverified) {
		t.Fatalf("wrong PID must fail closed, got %v", err)
	}
}

func TestPhase5LegacyFixed19447ActivationCompatibilityRemains(t *testing.T) {
	h := newPRHarness(t, nil, requiredRouteListen)
	if err := h.ctrl.activate(context.Background(), "6123456789abcdef0123456789abcdef"); err != nil {
		t.Fatalf("legacy fixed activation should remain available: %v", err)
	}
	if h.client.cfg == nil || h.client.cfg.TCP[publicRoutePort] == nil ||
		h.client.cfg.TCP[publicRoutePort].TCPForward != requiredRouteListen {
		t.Fatal("legacy fixed 19447 route target drifted")
	}
}
