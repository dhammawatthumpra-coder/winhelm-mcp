package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/windows"
	"tailscale.com/ipn"
)

type fakeServeClient struct {
	mu          sync.Mutex
	cfg         *ipn.ServeConfig
	getErr      error
	setErr      error
	getAfterSet *ipn.ServeConfig
	setCalls    int
}

func (f *fakeServeClient) GetServeConfig(context.Context) (*ipn.ServeConfig, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.getErr != nil {
		return nil, f.getErr
	}
	if f.setCalls > 0 && f.getAfterSet != nil {
		return f.getAfterSet, nil
	}
	if f.cfg == nil {
		return new(ipn.ServeConfig), nil
	}
	return f.cfg, nil
}

func (f *fakeServeClient) SetServeConfig(_ context.Context, sc *ipn.ServeConfig) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.setErr != nil {
		return f.setErr
	}
	f.setCalls++
	f.cfg = sc
	return nil
}

func (f *fakeServeClient) setCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.setCalls
}

const prTestHost = "ingress.example.test"

func activeRouteConfig(host, listen string) *ipn.ServeConfig {
	sc := new(ipn.ServeConfig)
	sc.SetTCPForwarding(publicRoutePort, listen, false, 0, "")
	sc.SetFunnel(host, publicRoutePort, true)
	return sc
}

type prHarness struct {
	client *fakeServeClient
	events *bytes.Buffer
	logger *eventLogger
	ctrl   *publicRouteController
}

func newPRHarness(t *testing.T, cfg *ipn.ServeConfig, listen string) *prHarness {
	t.Helper()
	events := &bytes.Buffer{}
	logger := newEventLogger(events)
	client := &fakeServeClient{cfg: cfg}
	return &prHarness{
		client: client,
		events: events,
		logger: logger,
		ctrl:   newPublicRouteController(client, prTestHost, listen, time.Second, logger),
	}
}

func (h *prHarness) eventSeen(name string) bool {
	return strings.Contains(h.events.String(), `"event":"`+name+`"`)
}

func (h *prHarness) newChannel(t *testing.T, dir string) *controlChannel {
	t.Helper()
	return newControlChannel(dir, winhelmServiceName, prTestHost, requiredRouteListen, h.ctrl, h.logger)
}

func writeControlRequest(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
}

const validActivateRequest = `{"version":1,"action":"activate","request_id":"0123456789abcdef0123456789abcdef"}`

func TestPublicRouteEnsureInactiveAcceptsEmptyConfig(t *testing.T) {
	h := newPRHarness(t, nil, requiredRouteListen)
	if err := h.ctrl.ensureInactive(context.Background(), "startup_prelisten"); err != nil {
		t.Fatal(err)
	}
	if h.client.setCount() != 0 {
		t.Fatal("ensureInactive wrote a serve config for an already-inactive route")
	}
	if !h.eventSeen("PUBLIC_ROUTE_CONFIRMED_INACTIVE") {
		t.Fatal("missing PUBLIC_ROUTE_CONFIRMED_INACTIVE event")
	}
}

func TestPublicRouteEnsureInactiveClearsStaleExactRoute(t *testing.T) {
	h := newPRHarness(t, activeRouteConfig(prTestHost, requiredRouteListen), requiredRouteListen)
	if err := h.ctrl.ensureInactive(context.Background(), "startup_prelisten"); err != nil {
		t.Fatal(err)
	}
	if h.client.setCount() != 1 {
		t.Fatalf("expected one clearing write, got %d", h.client.setCount())
	}
	if !h.eventSeen("PUBLIC_SERVE_STALE_CLEARED") {
		t.Fatal("missing PUBLIC_SERVE_STALE_CLEARED event")
	}
}

func TestPublicRouteEnsureInactiveClearsForeignFunnel(t *testing.T) {
	foreign := new(ipn.ServeConfig)
	foreign.SetFunnel("other.example.test", publicRoutePort, true)
	h := newPRHarness(t, foreign, requiredRouteListen)
	if err := h.ctrl.ensureInactive(context.Background(), "startup_prelisten"); err != nil {
		t.Fatal(err)
	}
	if h.client.setCount() != 1 {
		t.Fatalf("expected one clearing write, got %d", h.client.setCount())
	}
	if !h.eventSeen("PUBLIC_SERVE_STALE_CLEARED") {
		t.Fatal("foreign funnel was not cleared")
	}
}

func TestPublicRouteEnsureInactiveFailsClosedOnReadError(t *testing.T) {
	h := newPRHarness(t, nil, requiredRouteListen)
	h.client.getErr = errors.New("localapi down")
	err := h.ctrl.ensureInactive(context.Background(), "startup_prelisten")
	if !errors.Is(err, errRouteReadback) {
		t.Fatalf("err=%v", err)
	}
	if !h.eventSeen("PUBLIC_ROUTE_CONFIRM_FAILED") {
		t.Fatal("missing PUBLIC_ROUTE_CONFIRM_FAILED event")
	}
}

func TestPublicRouteEnsureInactiveFailsClosedOnClearError(t *testing.T) {
	h := newPRHarness(t, activeRouteConfig(prTestHost, requiredRouteListen), requiredRouteListen)
	h.client.setErr = errors.New("apply rejected")
	err := h.ctrl.ensureInactive(context.Background(), "startup_prelisten")
	if !errors.Is(err, errRouteApply) {
		t.Fatalf("err=%v", err)
	}
	if !h.eventSeen("PUBLIC_ROUTE_DEACTIVATION_FAILED") {
		t.Fatal("missing PUBLIC_ROUTE_DEACTIVATION_FAILED event")
	}
}

func TestPublicRouteEnsureInactiveFailsClosedWhenStillActive(t *testing.T) {
	h := newPRHarness(t, activeRouteConfig(prTestHost, requiredRouteListen), requiredRouteListen)
	h.client.getAfterSet = activeRouteConfig(prTestHost, requiredRouteListen)
	err := h.ctrl.ensureInactive(context.Background(), "startup_prelisten")
	if !errors.Is(err, errRouteStillActive) {
		t.Fatalf("err=%v", err)
	}
}

func TestPublicRouteActivateRequiresExactListener(t *testing.T) {
	h := newPRHarness(t, nil, "127.0.0.1:19555")
	err := h.ctrl.activate(context.Background(), "0123456789abcdef0123456789abcdef")
	if !errors.Is(err, errRouteListenMismatch) {
		t.Fatalf("err=%v", err)
	}
	if h.client.setCount() != 0 {
		t.Fatal("activation wrote a serve config despite listener mismatch")
	}
}

func TestPublicRouteActivateAppliesExactMapping(t *testing.T) {
	h := newPRHarness(t, nil, requiredRouteListen)
	if err := h.ctrl.activate(context.Background(), "0123456789abcdef0123456789abcdef"); err != nil {
		t.Fatal(err)
	}
	if h.client.setCount() != 1 {
		t.Fatalf("expected one write, got %d", h.client.setCount())
	}
	if !h.ctrl.exactActive(h.client.cfg) {
		t.Fatal("applied config is not the exact accepted mapping")
	}
	if !h.eventSeen("PUBLIC_SERVE_ACTIVE") {
		t.Fatal("missing PUBLIC_SERVE_ACTIVE event")
	}
}

func TestPublicRouteActivateReadbackMismatchFailsClosed(t *testing.T) {
	h := newPRHarness(t, nil, requiredRouteListen)
	h.client.getAfterSet = new(ipn.ServeConfig)
	err := h.ctrl.activate(context.Background(), "0123456789abcdef0123456789abcdef")
	if !errors.Is(err, errRouteReadback) {
		t.Fatalf("err=%v", err)
	}
	if !h.eventSeen("PUBLIC_ROUTE_ACTIVATION_FAILED") {
		t.Fatal("missing PUBLIC_ROUTE_ACTIVATION_FAILED event")
	}
}

func TestPublicRouteActivateApplyErrorFailsClosed(t *testing.T) {
	h := newPRHarness(t, nil, requiredRouteListen)
	h.client.setErr = errors.New("apply rejected")
	err := h.ctrl.activate(context.Background(), "0123456789abcdef0123456789abcdef")
	if !errors.Is(err, errRouteApply) {
		t.Fatalf("err=%v", err)
	}
	if h.eventSeen("PUBLIC_SERVE_ACTIVE") {
		t.Fatal("PUBLIC_SERVE_ACTIVE emitted despite apply failure")
	}
}

func TestPublicRouteDeactivateClearsAndConfirms(t *testing.T) {
	h := newPRHarness(t, activeRouteConfig(prTestHost, requiredRouteListen), requiredRouteListen)
	if err := h.ctrl.deactivate(context.Background(), "0123456789abcdef0123456789abcdef"); err != nil {
		t.Fatal(err)
	}
	if h.ctrl.routeActive(h.client.cfg) {
		t.Fatal("deactivation left an active route")
	}
	if !h.eventSeen("PUBLIC_SERVE_INACTIVE") {
		t.Fatal("missing PUBLIC_SERVE_INACTIVE event")
	}
}

func TestPublicRouteDeactivateApplyErrorFailsClosed(t *testing.T) {
	h := newPRHarness(t, activeRouteConfig(prTestHost, requiredRouteListen), requiredRouteListen)
	h.client.setErr = errors.New("apply rejected")
	err := h.ctrl.deactivate(context.Background(), "0123456789abcdef0123456789abcdef")
	if !errors.Is(err, errRouteApply) {
		t.Fatalf("err=%v", err)
	}
	if h.eventSeen("PUBLIC_SERVE_INACTIVE") {
		t.Fatal("PUBLIC_SERVE_INACTIVE emitted despite apply failure")
	}
}

func TestControlChannelProcessesActivateRequest(t *testing.T) {
	dir := t.TempDir()
	h := newPRHarness(t, nil, requiredRouteListen)
	cc := h.newChannel(t, dir)
	writeControlRequest(t, cc.requestPath(), validActivateRequest)
	cc.process(context.Background())
	if _, err := os.Stat(cc.requestPath()); !os.IsNotExist(err) {
		t.Fatal("request file was not consumed")
	}
	if h.client.setCount() != 1 {
		t.Fatalf("expected one activation write, got %d", h.client.setCount())
	}
	if !h.eventSeen("CONTROL_REQUEST_PROCESSED") {
		t.Fatal("missing CONTROL_REQUEST_PROCESSED event")
	}
	status, err := readStatusFile(cc.statusPath())
	if err != nil {
		t.Fatal(err)
	}
	if status.PublicRoute != "active" || status.LastRequest == nil || status.LastRequest.Result != "ok" || status.LastRequest.Action != "activate" {
		t.Fatalf("status=%+v last=%+v", status, status.LastRequest)
	}
}

func TestControlChannelProcessesDeactivateRequest(t *testing.T) {
	dir := t.TempDir()
	h := newPRHarness(t, nil, requiredRouteListen)
	cc := h.newChannel(t, dir)
	writeControlRequest(t, cc.requestPath(), validActivateRequest)
	cc.process(context.Background())
	writeControlRequest(t, cc.requestPath(), `{"version":1,"action":"deactivate","request_id":"fedcba9876543210fedcba9876543210"}`)
	cc.process(context.Background())
	if h.client.setCount() != 2 {
		t.Fatalf("expected activate + clear writes, got %d", h.client.setCount())
	}
	status, err := readStatusFile(cc.statusPath())
	if err != nil {
		t.Fatal(err)
	}
	if status.PublicRoute != "inactive" || status.LastRequest == nil || status.LastRequest.Action != "deactivate" {
		t.Fatalf("status=%+v last=%+v", status, status.LastRequest)
	}
	if !h.eventSeen("PUBLIC_SERVE_INACTIVE") {
		t.Fatal("missing PUBLIC_SERVE_INACTIVE event")
	}
}

func TestControlChannelDiscardsStaleRequestAtStartup(t *testing.T) {
	dir := t.TempDir()
	h := newPRHarness(t, nil, requiredRouteListen)
	cc := h.newChannel(t, dir)
	writeControlRequest(t, cc.requestPath(), validActivateRequest)
	cc.discardStaleRequest()
	if _, err := os.Stat(cc.requestPath()); !os.IsNotExist(err) {
		t.Fatal("stale request survived startup discard")
	}
	if h.client.setCount() != 0 {
		t.Fatal("stale request triggered activation")
	}
	if !strings.Contains(h.events.String(), "stale_request_at_startup") {
		t.Fatal("missing stale_request_at_startup event")
	}
}

func TestControlChannelRejectsInvalidRequest(t *testing.T) {
	dir := t.TempDir()
	h := newPRHarness(t, nil, requiredRouteListen)
	cc := h.newChannel(t, dir)
	writeControlRequest(t, cc.requestPath(), `{"version":2,"action":"activate","request_id":"0123456789abcdef0123456789abcdef","extra":true}`)
	cc.process(context.Background())
	if _, err := os.Stat(cc.requestPath()); !os.IsNotExist(err) {
		t.Fatal("invalid request file was not discarded")
	}
	if h.client.setCount() != 0 {
		t.Fatal("invalid request triggered an action")
	}
	if !strings.Contains(h.events.String(), "invalid_request") {
		t.Fatal("missing invalid_request rejection event")
	}
}

func TestControlChannelRejectsOversizeRequest(t *testing.T) {
	dir := t.TempDir()
	h := newPRHarness(t, nil, requiredRouteListen)
	cc := h.newChannel(t, dir)
	writeControlRequest(t, cc.requestPath(), strings.Repeat(" ", controlRequestMaxBytes+1))
	cc.process(context.Background())
	if h.client.setCount() != 0 {
		t.Fatal("oversize request triggered an action")
	}
	if !strings.Contains(h.events.String(), "request_too_large") {
		t.Fatal("missing request_too_large rejection event")
	}
}

func TestControlChannelRejectsDuplicateRequest(t *testing.T) {
	dir := t.TempDir()
	h := newPRHarness(t, nil, requiredRouteListen)
	cc := h.newChannel(t, dir)
	writeControlRequest(t, cc.requestPath(), validActivateRequest)
	cc.process(context.Background())
	writeControlRequest(t, cc.requestPath(), validActivateRequest)
	cc.process(context.Background())
	if h.client.setCount() != 1 {
		t.Fatalf("duplicate request replayed the action: writes=%d", h.client.setCount())
	}
	if !strings.Contains(h.events.String(), "duplicate_request") {
		t.Fatal("missing duplicate_request rejection event")
	}
}

func TestControlChannelRejectsUnreadableRequest(t *testing.T) {
	dir := t.TempDir()
	h := newPRHarness(t, nil, requiredRouteListen)
	cc := h.newChannel(t, dir)
	if err := os.Mkdir(cc.requestPath(), 0700); err != nil {
		t.Fatal(err)
	}
	cc.process(context.Background())
	if h.client.setCount() != 0 {
		t.Fatal("unreadable request triggered an action")
	}
	if !strings.Contains(h.events.String(), "request_unreadable") {
		t.Fatal("missing request_unreadable rejection event")
	}
}

func TestControlChannelRejectsRequestWhenDeleteFails(t *testing.T) {
	dir := t.TempDir()
	h := newPRHarness(t, nil, requiredRouteListen)
	cc := h.newChannel(t, dir)
	writeControlRequest(t, cc.requestPath(), validActivateRequest)
	// Hold the request open with a share mode that allows reads but not
	// deletes, so the request is readable and the one-shot delete must fail.
	pathp, err := windows.UTF16PtrFromString(cc.requestPath())
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(pathp, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(handle)
	cc.process(context.Background())
	if _, statErr := os.Stat(cc.requestPath()); os.IsNotExist(statErr) {
		t.Fatal("undeletable request file disappeared")
	}
	if h.client.setCount() != 0 {
		t.Fatal("undeletable request was processed anyway")
	}
	if !strings.Contains(h.events.String(), "request_delete_failed") {
		t.Fatal("missing request_delete_failed rejection event")
	}
}

func TestControlChannelStatusIsSanitizedAndBounded(t *testing.T) {
	dir := t.TempDir()
	h := newPRHarness(t, nil, requiredRouteListen)
	cc := h.newChannel(t, dir)
	writeControlRequest(t, cc.requestPath(), validActivateRequest)
	cc.process(context.Background())
	raw, err := os.ReadFile(cc.statusPath())
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) > controlRequestMaxBytes {
		t.Fatalf("status file exceeds bound: %d bytes", len(raw))
	}
	status, err := readStatusFile(cc.statusPath())
	if err != nil {
		t.Fatal(err)
	}
	if status.Version != 1 || status.Service != winhelmServiceName || status.PublicPort != publicRoutePort ||
		status.LocalListener != requiredRouteListen || status.PublicHost != prTestHost || status.UpdatedAt == "" {
		t.Fatalf("status=%+v", status)
	}
	if status.PublicRoute != "active" || status.LastRequest == nil || status.LastRequest.RequestID != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("status=%+v", status)
	}
}

func readStatusFile(path string) (controlStatus, error) {
	var status controlStatus
	raw, err := os.ReadFile(path)
	if err != nil {
		return status, err
	}
	if len(raw) > controlRequestMaxBytes {
		return status, errors.New("status file exceeds bound")
	}
	if err := json.Unmarshal(raw, &status); err != nil {
		return status, err
	}
	return status, nil
}

func TestPublicRouteActiveIsForegroundAware(t *testing.T) {
	h := newPRHarness(t, nil, requiredRouteListen)

	foregroundTCP := new(ipn.ServeConfig)
	foregroundTCP.Foreground = map[string]*ipn.ServeConfig{
		"fg-session-tcp": func() *ipn.ServeConfig {
			fg := new(ipn.ServeConfig)
			fg.SetTCPForwarding(publicRoutePort, requiredRouteListen, false, 0, "")
			return fg
		}(),
	}
	if !h.ctrl.routeActive(foregroundTCP) {
		t.Fatal("foreground TCP/443 mapping was not detected as active")
	}

	foregroundFunnel := new(ipn.ServeConfig)
	foregroundFunnel.Foreground = map[string]*ipn.ServeConfig{
		"fg-session-funnel": func() *ipn.ServeConfig {
			fg := new(ipn.ServeConfig)
			fg.SetFunnel(prTestHost, publicRoutePort, true)
			return fg
		}(),
	}
	if !h.ctrl.routeActive(foregroundFunnel) {
		t.Fatal("foreground funnel exposure was not detected as active")
	}

	foregroundForeignFunnel := new(ipn.ServeConfig)
	foregroundForeignFunnel.Foreground = map[string]*ipn.ServeConfig{
		"fg-session-foreign": func() *ipn.ServeConfig {
			fg := new(ipn.ServeConfig)
			fg.SetFunnel("other.example.test", publicRoutePort, true)
			return fg
		}(),
	}
	if !h.ctrl.routeActive(foregroundForeignFunnel) {
		t.Fatal("foreground funnel on another host was not detected as active")
	}

	if h.ctrl.routeActive(new(ipn.ServeConfig)) {
		t.Fatal("empty readback was reported active")
	}
}

func TestPublicRouteEnsureInactiveClearsStaleForegroundRoute(t *testing.T) {
	stale := new(ipn.ServeConfig)
	stale.Foreground = map[string]*ipn.ServeConfig{
		"fg-session-stale": func() *ipn.ServeConfig {
			fg := new(ipn.ServeConfig)
			fg.SetTCPForwarding(publicRoutePort, requiredRouteListen, false, 0, "")
			return fg
		}(),
	}
	h := newPRHarness(t, stale, requiredRouteListen)
	if err := h.ctrl.ensureInactive(context.Background(), "startup_prelisten"); err != nil {
		t.Fatal(err)
	}
	if h.client.setCount() != 1 {
		t.Fatalf("foreground stale route was not cleared with exactly one write: writes=%d", h.client.setCount())
	}
	if h.ctrl.routeActive(h.client.cfg) {
		t.Fatal("foreground route remained active after the stale clear")
	}
	if !h.eventSeen("PUBLIC_SERVE_STALE_CLEARED") || !h.eventSeen("PUBLIC_ROUTE_CONFIRMED_INACTIVE") {
		t.Fatal("foreground stale clear did not emit the cleared + confirmed-inactive events")
	}
}

func TestPublicDecouplingSourcePins(t *testing.T) {
	b, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	if n := strings.Count(s, "SetFunnel("); n != 1 {
		t.Fatalf("expected exactly one SetFunnel call, got %d", n)
	}
	if n := strings.Count(s, "SetTCPForwarding("); n != 1 {
		t.Fatalf("expected exactly one SetTCPForwarding call, got %d", n)
	}
	body := runIngressBody(t, s)
	forbidden := []string{"PUBLIC_SERVE_ACTIVE", "isolated_funnel_contract", "SetFunnel(", "SetTCPForwarding("}
	for _, needle := range forbidden {
		if strings.Contains(body, needle) {
			t.Fatalf("runIngress body contains forbidden activation marker: %s", needle)
		}
	}
	order := []string{
		"acquireStateLock(stateDir)",
		"srv.Up(startupCtx)",
		"srv.LocalClient()",
		"controlDir := filepath.Join(stateDir, controlDirName)",
		"control.discardStaleRequest()",
		`ensureInactive(ctx, "startup_prelisten")`,
		"manager.refresh(ctx)",
		"bindInternalListener(listenPlan)",
		`ensureInactive(ctx, "startup_preready")`,
		"GO_TLS_INGRESS_READY",
		`"public_route": "inactive"`,
		"ready()",
	}
	last := -1
	for _, needle := range order {
		idx := strings.Index(s, needle)
		if idx < 0 {
			t.Fatalf("startup ordering marker missing: %s", needle)
		}
		if idx <= last {
			t.Fatalf("startup ordering violated at marker: %s", needle)
		}
		last = idx
	}
	if !strings.Contains(body, "control.process(ctx)") {
		t.Fatal("control channel is not polled inside the run loop")
	}
	if !strings.Contains(body, `clearRoute(ctx, "stop")`) {
		t.Fatal("stop path does not clear the public route")
	}
	if strings.Contains(body, "log.Fatal") {
		t.Fatal("runIngress still contains a fatal exit")
	}
}

func runIngressBody(t *testing.T, s string) string {
	t.Helper()
	start := strings.Index(s, "func runIngress(")
	if start < 0 {
		t.Fatal("runIngress not found")
	}
	body := s[start:]
	if end := strings.Index(body[1:], "\nfunc "); end >= 0 {
		body = body[:end+1]
	}
	return body
}

func TestRunEntrypointConsoleWithoutConfigFailsClosed(t *testing.T) {
	err := runEntrypoint("", false, false)
	if err == nil || !strings.Contains(err.Error(), "--config is required") {
		t.Fatalf("err=%v", err)
	}
}
