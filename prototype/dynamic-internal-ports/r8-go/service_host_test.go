//go:build windows

package main

import (
	"context"
	"errors"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows/svc"
)

func pinServiceWindowsTimings(t *testing.T) {
	t.Helper()
	oldInterval, oldCap := serviceStartPendingInterval, serviceStopWaitHardCap
	serviceStartPendingInterval, serviceStopWaitHardCap = 5*time.Second, 5*time.Second
	t.Cleanup(func() {
		serviceStartPendingInterval, serviceStopWaitHardCap = oldInterval, oldCap
	})
}

type svcHarness struct {
	r       chan svc.ChangeRequest
	changes chan svc.Status
	done    chan struct{}
	ss      bool
	errno   uint32
}

func startSvcHarness(t *testing.T, h *winhelmServiceHandler) *svcHarness {
	t.Helper()
	harness := &svcHarness{
		r:       make(chan svc.ChangeRequest),
		changes: make(chan svc.Status),
		done:    make(chan struct{}),
	}
	go func() {
		ss, errno := h.Execute(nil, harness.r, harness.changes)
		harness.ss, harness.errno = ss, errno
		close(harness.done)
	}()
	return harness
}

func (h *svcHarness) nextStatus(t *testing.T, timeout time.Duration) svc.Status {
	t.Helper()
	select {
	case st := <-h.changes:
		return st
	case <-time.After(timeout):
		t.Fatal("timeout waiting for service status")
		return svc.Status{}
	}
}

func (h *svcHarness) send(t *testing.T, cmd svc.Cmd) {
	t.Helper()
	select {
	case h.r <- svc.ChangeRequest{Cmd: cmd}:
	case <-time.After(time.Second):
		t.Fatal("timeout sending service control")
	}
}

func (h *svcHarness) waitDone(t *testing.T, timeout time.Duration) (bool, uint32) {
	t.Helper()
	select {
	case <-h.done:
		return h.ss, h.errno
	case <-time.After(timeout):
		t.Fatal("timeout waiting for Execute to return")
		return false, 0
	}
}

func (h *svcHarness) expectNoStatus(t *testing.T) {
	t.Helper()
	select {
	case st := <-h.changes:
		t.Fatalf("unexpected service status after completion: %+v", st)
	case <-time.After(50 * time.Millisecond):
	}
}

func waitUntilReady() (chan struct{}, func()) {
	startReady := make(chan struct{})
	return startReady, func() { close(startReady) }
}

func TestServiceHostHandlerLifecycle(t *testing.T) {
	pinServiceWindowsTimings(t)
	startReady, nowReady := waitUntilReady()
	h := &winhelmServiceHandler{run: func(ctx context.Context, ready func()) error {
		select {
		case <-startReady:
			ready()
		case <-ctx.Done():
			return nil
		}
		<-ctx.Done()
		return nil
	}}
	harness := startSvcHarness(t, h)

	first := harness.nextStatus(t, time.Second)
	if first.State != svc.StartPending || first.WaitHint != serviceWaitHintMS {
		t.Fatalf("first status=%+v", first)
	}
	nowReady()
	running := harness.nextStatus(t, time.Second)
	if running.State != svc.Running || running.Accepts&(svc.AcceptStop|svc.AcceptShutdown) != svc.AcceptStop|svc.AcceptShutdown {
		t.Fatalf("running status=%+v", running)
	}
	harness.send(t, svc.Interrogate)
	interrogated := harness.nextStatus(t, time.Second)
	if interrogated.State != svc.Running {
		t.Fatalf("interrogate status=%+v", interrogated)
	}
	harness.send(t, svc.Stop)
	stopPending := harness.nextStatus(t, time.Second)
	if stopPending.State != svc.StopPending {
		t.Fatalf("stop status=%+v", stopPending)
	}
	if ss, errno := harness.waitDone(t, 2*time.Second); ss || errno != 0 {
		t.Fatalf("ss=%v errno=%d", ss, errno)
	}
}

func TestServiceHostHandlerStartupFailureIsDeterministic(t *testing.T) {
	pinServiceWindowsTimings(t)
	h := &winhelmServiceHandler{run: func(context.Context, func()) error {
		return errors.New("startup boom")
	}}
	harness := startSvcHarness(t, h)
	if st := harness.nextStatus(t, time.Second); st.State != svc.StartPending {
		t.Fatalf("first status=%+v", st)
	}
	if ss, errno := harness.waitDone(t, time.Second); ss || errno != serviceFailureExitCode {
		t.Fatalf("ss=%v errno=%d", ss, errno)
	}
	harness.expectNoStatus(t)
}

func TestServiceHostHandlerRuntimeFailureExitsNonzero(t *testing.T) {
	pinServiceWindowsTimings(t)
	failNow := make(chan struct{})
	h := &winhelmServiceHandler{run: func(ctx context.Context, ready func()) error {
		ready()
		<-failNow
		return errors.New("serve boom")
	}}
	harness := startSvcHarness(t, h)
	if st := harness.nextStatus(t, time.Second); st.State != svc.StartPending {
		t.Fatalf("first status=%+v", st)
	}
	if st := harness.nextStatus(t, time.Second); st.State != svc.Running {
		t.Fatalf("second status=%+v", st)
	}
	close(failNow)
	if ss, errno := harness.waitDone(t, time.Second); ss || errno != serviceFailureExitCode {
		t.Fatalf("ss=%v errno=%d", ss, errno)
	}
	harness.expectNoStatus(t)
}

func TestServiceHostHandlerStopDuringStartup(t *testing.T) {
	pinServiceWindowsTimings(t)
	h := &winhelmServiceHandler{run: func(ctx context.Context, ready func()) error {
		<-ctx.Done()
		return nil
	}}
	harness := startSvcHarness(t, h)
	if st := harness.nextStatus(t, time.Second); st.State != svc.StartPending {
		t.Fatalf("first status=%+v", st)
	}
	harness.send(t, svc.Stop)
	if st := harness.nextStatus(t, time.Second); st.State != svc.StopPending {
		t.Fatalf("stop status=%+v", st)
	}
	if ss, errno := harness.waitDone(t, 2*time.Second); ss || errno != 0 {
		t.Fatalf("ss=%v errno=%d", ss, errno)
	}
}

func TestServiceHostHandlerShutdownRequestMatchesStop(t *testing.T) {
	pinServiceWindowsTimings(t)
	h := &winhelmServiceHandler{run: func(ctx context.Context, ready func()) error {
		<-ctx.Done()
		return nil
	}}
	harness := startSvcHarness(t, h)
	if st := harness.nextStatus(t, time.Second); st.State != svc.StartPending {
		t.Fatalf("first status=%+v", st)
	}
	harness.send(t, svc.Shutdown)
	if st := harness.nextStatus(t, time.Second); st.State != svc.StopPending {
		t.Fatalf("shutdown status=%+v", st)
	}
	if ss, errno := harness.waitDone(t, 2*time.Second); ss || errno != 0 {
		t.Fatalf("ss=%v errno=%d", ss, errno)
	}
}

func TestServiceHostHandlerStopWaitIsBoundedOnStuckRun(t *testing.T) {
	pinServiceWindowsTimings(t)
	serviceStopWaitHardCap = 20 * time.Millisecond
	never := make(chan struct{})
	h := &winhelmServiceHandler{run: func(context.Context, func()) error {
		<-never
		return nil
	}}
	harness := startSvcHarness(t, h)
	if st := harness.nextStatus(t, time.Second); st.State != svc.StartPending {
		t.Fatalf("first status=%+v", st)
	}
	harness.send(t, svc.Stop)
	if st := harness.nextStatus(t, time.Second); st.State != svc.StopPending {
		t.Fatalf("stop status=%+v", st)
	}
	if ss, errno := harness.waitDone(t, 2*time.Second); ss || errno != 0 {
		t.Fatalf("ss=%v errno=%d", ss, errno)
	}
}

func TestServiceHostHandlerCheckpointAdvancesWhileStarting(t *testing.T) {
	pinServiceWindowsTimings(t)
	serviceStartPendingInterval = 10 * time.Millisecond
	startReady, nowReady := waitUntilReady()
	h := &winhelmServiceHandler{run: func(ctx context.Context, ready func()) error {
		select {
		case <-startReady:
			ready()
		case <-ctx.Done():
			return nil
		}
		<-ctx.Done()
		return nil
	}}
	harness := startSvcHarness(t, h)

	first := harness.nextStatus(t, time.Second)
	if first.State != svc.StartPending || first.CheckPoint != 0 {
		t.Fatalf("first status=%+v", first)
	}
	var lastCheckpoint uint32
	for i := 0; i < 3; i++ {
		st := harness.nextStatus(t, time.Second)
		if st.State != svc.StartPending {
			t.Fatalf("pending status=%+v", st)
		}
		if st.CheckPoint <= lastCheckpoint {
			t.Fatalf("checkpoint did not advance: %d after %d", st.CheckPoint, lastCheckpoint)
		}
		lastCheckpoint = st.CheckPoint
	}
	nowReady()
	var running svc.Status
	deadline := time.Now().Add(3 * time.Second)
	for {
		st := harness.nextStatus(t, time.Until(deadline))
		if st.State == svc.Running {
			running = st
			break
		}
		if st.State != svc.StartPending || st.CheckPoint <= lastCheckpoint {
			t.Fatalf("unexpected status while waiting for Running: %+v", st)
		}
		lastCheckpoint = st.CheckPoint
	}
	if running.Accepts&(svc.AcceptStop|svc.AcceptShutdown) != svc.AcceptStop|svc.AcceptShutdown {
		t.Fatalf("running status=%+v", running)
	}
	harness.send(t, svc.Interrogate)
	if st := harness.nextStatus(t, time.Second); st.State != svc.Running {
		t.Fatalf("post-ready status regressed: %+v", st)
	}
	harness.send(t, svc.Stop)
	if st := harness.nextStatus(t, time.Second); st.State != svc.StopPending {
		t.Fatalf("stop status=%+v", st)
	}
	if ss, errno := harness.waitDone(t, 2*time.Second); ss || errno != 0 {
		t.Fatalf("ss=%v errno=%d", ss, errno)
	}
}

func TestServiceHostHandlerReadyIsPublishedOnce(t *testing.T) {
	pinServiceWindowsTimings(t)
	firstReady := make(chan struct{})
	done := make(chan struct{})
	h := &winhelmServiceHandler{run: func(ctx context.Context, ready func()) error {
		<-firstReady
		ready()
		ready()
		close(done)
		<-ctx.Done()
		return nil
	}}
	harness := startSvcHarness(t, h)
	if st := harness.nextStatus(t, time.Second); st.State != svc.StartPending {
		t.Fatalf("first status=%+v", st)
	}
	close(firstReady)
	if st := harness.nextStatus(t, time.Second); st.State != svc.Running {
		t.Fatalf("running status=%+v", st)
	}
	<-done
	harness.send(t, svc.Interrogate)
	if st := harness.nextStatus(t, time.Second); st.State != svc.Running {
		t.Fatalf("duplicate ready changed state: %+v", st)
	}
	harness.send(t, svc.Stop)
	if st := harness.nextStatus(t, time.Second); st.State != svc.StopPending {
		t.Fatalf("stop status=%+v", st)
	}
	if ss, errno := harness.waitDone(t, 2*time.Second); ss || errno != 0 {
		t.Fatalf("ss=%v errno=%d", ss, errno)
	}
}

func TestServiceHostRefusesLoginAndEmptyConfigBeforeDispatch(t *testing.T) {
	if err := runServiceHost("config.json", true); !errors.Is(err, errServiceLoginForbidden) {
		t.Fatalf("login refusal err=%v", err)
	}
	if err := runServiceHost("", false); err == nil || !strings.Contains(err.Error(), "--config is required") {
		t.Fatalf("empty config err=%v", err)
	}
}

func TestServiceHostDetectionIsConsoleFalse(t *testing.T) {
	// The detector remains only the secondary hardening net in runEntrypoint;
	// the production service lane is selected by --service and never calls it.
	inService, err := isWindowsService()
	if err != nil {
		t.Fatal(err)
	}
	if inService {
		t.Fatal("test process reported as SCM-launched")
	}
}

func TestServiceHostNameMatchesInstaller(t *testing.T) {
	if winhelmServiceName != "WinHelmGoTlsIngressHardeningR1" {
		t.Fatalf("service name=%q", winhelmServiceName)
	}
	b, err := os.ReadFile("package/install-service.ps1")
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	if !strings.Contains(s, "'"+winhelmServiceName+"'") {
		t.Fatal("installer service name does not match the dispatcher name")
	}
	if !strings.Contains(s, "--service'") {
		t.Fatal("installer ImagePath does not carry the explicit service mode argument")
	}
	if strings.Contains(s, "--login") {
		t.Fatal("installer must not embed --login")
	}
}

func TestServiceHostSourcePins(t *testing.T) {
	b, err := os.ReadFile("service_windows.go")
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	required := []string{
		"svc.Run(winhelmServiceName,",
		"svc.IsWindowsService()",
		"svc.StartPending",
		"svc.Running",
		"svc.AcceptStop | svc.AcceptShutdown",
		"svc.StopPending",
		"CheckPoint: checkpoint",
		"serviceFailureExitCode",
	}
	for _, needle := range required {
		if !strings.Contains(s, needle) {
			t.Fatalf("service host pin missing: %s", needle)
		}
	}
	forbidden := []string{"svc.Stopped", "SetServeConfig", "SetFunnel", "SetTCPForwarding"}
	for _, needle := range forbidden {
		if strings.Contains(s, needle) {
			t.Fatalf("forbidden service host marker present: %s", needle)
		}
	}
	interval := regexp.MustCompile(`serviceStartPendingInterval\s*=\s*5 \* time\.Second`)
	if !interval.MatchString(s) {
		t.Fatal("start pending interval pin missing")
	}
	capRE := regexp.MustCompile(`serviceStopWaitHardCap\s*=\s*45 \* time\.Minute`)
	if !capRE.MatchString(s) {
		t.Fatal("stop wait hard cap pin missing")
	}
	if strings.Index(s, "errServiceLoginForbidden") > strings.Index(s, "svc.Run(") {
		t.Fatal("login refusal is not enforced before the dispatcher is entered")
	}
}

func TestServiceHostExplicitServiceModeSourcePins(t *testing.T) {
	b, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	if !strings.Contains(s, `flag.Bool("service", false,`) {
		t.Fatal("explicit service mode flag is not declared")
	}
	if !strings.Contains(s, "func runEntrypoint(configPath string, loginOnly, serviceMode bool) error {") {
		t.Fatal("runEntrypoint does not take the explicit service mode argument")
	}
	flagCheck := strings.Index(s, "if serviceMode {")
	detector := strings.Index(s, "inService, err := detectWindowsService()")
	svcHost := strings.Index(s, "return serviceHostRunner(configPath, loginOnly)")
	if flagCheck < 0 || detector < 0 || svcHost < 0 {
		t.Fatal("explicit dispatch marker missing from runEntrypoint")
	}
	if !(flagCheck < detector) {
		t.Fatal("--service dispatch does not precede the IsWindowsService fallback")
	}
	if strings.Count(s, "return serviceHostRunner(configPath, loginOnly)") != 2 {
		t.Fatal("expected exactly the flagged and autodetected service host entries")
	}
	flagCall := strings.Index(s, "runEntrypoint(*configPath, *loginOnly, *serviceMode)")
	if flagCall < 0 {
		t.Fatal("main does not pass the parsed service mode flag to runEntrypoint")
	}
	if strings.Contains(stripGoComments(s), "svc.IsWindowsService()") {
		t.Fatal("main.go must not call the SCM autodetector directly")
	}
}

// stripGoComments removes // comment lines so source pins assert on code, not
// on documentation that quotes the same identifier.
func stripGoComments(s string) string {
	var b strings.Builder
	for _, line := range strings.Split(s, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "//") {
			continue
		}
		b.WriteString(line)
		b.WriteString("\n")
	}
	return b.String()
}

func TestServiceHostExplicitServiceModeDispatch(t *testing.T) {
	oldDetector, oldHost := detectWindowsService, serviceHostRunner
	defer func() {
		detectWindowsService, serviceHostRunner = oldDetector, oldHost
	}()

	detectorCalls, hostCalls := 0, 0
	detectWindowsService = func() (bool, error) {
		detectorCalls++
		return false, errors.New("detector must not be consulted in explicit service mode")
	}
	serviceHostRunner = func(string, bool) error {
		hostCalls++
		return nil
	}

	if err := runEntrypoint("config.json", false, true); err != nil {
		t.Fatalf("explicit service mode did not enter the service host: %v", err)
	}
	if hostCalls != 1 {
		t.Fatalf("service host entered %d times, want 1", hostCalls)
	}
	if detectorCalls != 0 {
		t.Fatalf("explicit service mode consulted the SCM autodetector %d times", detectorCalls)
	}
}

func TestServiceHostExplicitServiceModeFailClosed(t *testing.T) {
	oldDetector, oldHost := detectWindowsService, serviceHostRunner
	defer func() {
		detectWindowsService, serviceHostRunner = oldDetector, oldHost
	}()

	detectorCalls := 0
	detectWindowsService = func() (bool, error) {
		detectorCalls++
		return false, errors.New("detector must not be consulted in explicit service mode")
	}
	serviceHostRunner = func(configPath string, loginOnly bool) error {
		return runServiceHost(configPath, loginOnly)
	}

	if err := runEntrypoint("config.json", true, true); !errors.Is(err, errServiceLoginForbidden) {
		t.Fatalf("--service --login err=%v", err)
	}
	if err := runEntrypoint("", false, true); err == nil || !strings.Contains(err.Error(), "--config is required") {
		t.Fatalf("--service without config err=%v", err)
	}
	if detectorCalls != 0 {
		t.Fatalf("fail-closed service mode consulted the SCM autodetector %d times", detectorCalls)
	}
}

func TestServiceHostDetectionErrorFailsClosed(t *testing.T) {
	oldDetector, oldHost := detectWindowsService, serviceHostRunner
	defer func() {
		detectWindowsService, serviceHostRunner = oldDetector, oldHost
	}()

	detectorCalls, hostCalls := 0, 0
	detectWindowsService = func() (bool, error) {
		detectorCalls++
		return false, errors.New("scm probe failed")
	}
	serviceHostRunner = func(string, bool) error {
		hostCalls++
		return nil
	}

	err := runEntrypoint("config.json", false, false)
	if err == nil || !strings.Contains(err.Error(), "service detection") {
		t.Fatalf("detection error was not fail-closed: err=%v", err)
	}
	if detectorCalls != 1 {
		t.Fatalf("autodetector consulted %d times, want 1", detectorCalls)
	}
	if hostCalls != 0 {
		t.Fatalf("service host entered %d times despite the detection error", hostCalls)
	}
}
