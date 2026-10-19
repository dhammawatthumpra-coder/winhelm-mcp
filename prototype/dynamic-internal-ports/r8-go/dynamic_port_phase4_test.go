package main

import (
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

func TestPhase4AutoListenPlanRequiresExplicitLoopbackZeroSentinel(t *testing.T) {
	cfg := config{Listen: "127.0.0.1:0", ListenMode: "auto", PreferredPort: 0}
	plan, err := listenPlanFromConfig(cfg)
	if err != nil {
		t.Fatalf("auto plan rejected: %v", err)
	}
	if plan.mode != listenModeAuto || plan.host != "127.0.0.1" || plan.preferredPort != 0 {
		t.Fatalf("unexpected auto plan: %+v", plan)
	}

	cfg.Listen = "0.0.0.0:0"
	if _, err := listenPlanFromConfig(cfg); err == nil {
		t.Fatal("non-loopback auto listen must fail closed")
	}

	cfg.Listen = "127.0.0.1:19447"
	if _, err := listenPlanFromConfig(cfg); err == nil {
		t.Fatal("auto mode must require the explicit :0 sentinel")
	}
}

func TestPhase4FixedListenCompatibilityRemainsExact(t *testing.T) {
	cfg := config{Listen: "127.0.0.1:19447"}
	plan, err := listenPlanFromConfig(cfg)
	if err != nil {
		t.Fatalf("legacy fixed plan rejected: %v", err)
	}
	if plan.mode != listenModeFixed || plan.fixedPort != 19447 {
		t.Fatalf("unexpected fixed plan: %+v", plan)
	}
}

func TestPhase4AutoBindFallsBackFromOccupiedPreferredPortThroughRealBind(t *testing.T) {
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	occupiedPort := occupied.Addr().(*net.TCPAddr).Port

	plan := internalListenPlan{
		mode:          listenModeAuto,
		host:          "127.0.0.1",
		preferredPort: occupiedPort,
	}
	listener, err := bindInternalListener(plan)
	if err != nil {
		t.Fatalf("auto bind failed: %v", err)
	}
	defer listener.Close()

	actual := listener.Addr().(*net.TCPAddr).Port
	if actual == occupiedPort || actual == 0 {
		t.Fatalf("expected OS-selected fallback port, got %d", actual)
	}
}

func TestPhase4FixedCollisionDoesNotFallback(t *testing.T) {
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	occupiedPort := occupied.Addr().(*net.TCPAddr).Port

	_, err = bindInternalListener(internalListenPlan{
		mode:      listenModeFixed,
		host:      "127.0.0.1",
		fixedPort: occupiedPort,
	})
	if err == nil {
		t.Fatal("fixed collision must fail instead of falling back")
	}
}

func TestPhase4RuntimeHealthIsGenerationBoundAndDoesNotReachProxy(t *testing.T) {
	nextCalls := 0
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalls++
		w.WriteHeader(http.StatusNoContent)
	})
	generation := "11111111-1111-4111-8111-111111111111"
	h := runtimeHealthHandler(next, generation, 5151)

	missing := httptest.NewRecorder()
	h.ServeHTTP(missing, httptest.NewRequest(http.MethodGet, "/health", nil))
	if missing.Code != http.StatusNotFound || nextCalls != 0 {
		t.Fatalf("hidden health mismatch: code=%d calls=%d", missing.Code, nextCalls)
	}

	ok := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set(runtimeGenerationHeader, generation)
	h.ServeHTTP(ok, req)
	if ok.Code != http.StatusOK || nextCalls != 0 {
		t.Fatalf("verified health mismatch: code=%d calls=%d", ok.Code, nextCalls)
	}

	normal := httptest.NewRecorder()
	h.ServeHTTP(normal, httptest.NewRequest(http.MethodGet, "/mcp", nil))
	if normal.Code != http.StatusNoContent || nextCalls != 1 {
		t.Fatalf("normal routing mismatch: code=%d calls=%d", normal.Code, nextCalls)
	}
}

func TestPhase4DynamicListenerCannotActivatePublic443BeforePhase5(t *testing.T) {
	h := newPRHarness(t, nil, "127.0.0.1:62003")
	err := h.ctrl.activate(t.Context(), "0123456789abcdef0123456789abcdef")
	if !errors.Is(err, errRouteListenMismatch) {
		t.Fatalf("dynamic listener must remain blocked from public activation, got %v", err)
	}
}

func TestPhase4PreferredPortValidation(t *testing.T) {
	for _, port := range []int{1, 1023, 65536} {
		cfg := config{
			Listen:        "127.0.0.1:0",
			ListenMode:    "auto",
			PreferredPort: port,
		}
		if _, err := listenPlanFromConfig(cfg); err == nil {
			t.Fatalf("preferred port %s should be rejected", strconv.Itoa(port))
		}
	}
}
