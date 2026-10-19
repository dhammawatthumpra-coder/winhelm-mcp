//go:build windows

package main

import (
	"context"
	"errors"
	"sync"
	"time"

	"golang.org/x/sys/windows/svc"
)

const (
	serviceWaitHintMS      = 30000
	serviceFailureExitCode = 1
)

// These are variables so the regression suite can shrink the intervals; the
// production values are the pinned defaults below.
var (
	serviceStartPendingInterval = 5 * time.Second
	serviceStopWaitHardCap      = 45 * time.Minute
)

var errServiceLoginForbidden = errors.New("--login is not available in service mode")

// detectWindowsService and serviceHostRunner are the runEntrypoint seam; the
// production values are the pinned implementations below.
var (
	detectWindowsService = isWindowsService
	serviceHostRunner    = runServiceHost
)

// isWindowsService reports whether this process was started by the Windows
// service control manager. It is only the secondary hardening net in
// runEntrypoint for a non-flagged SCM launch; the production service lane is
// selected by --service and never calls it. A detection error is fail-closed:
// the process must not silently guess between the console lane and the
// service lane.
func isWindowsService() (bool, error) {
	inService, err := svc.IsWindowsService()
	if err != nil {
		return false, err
	}
	return inService, nil
}

// runServiceHost enters the native SCM service protocol for the explicit
// service lane. Credential enrollment remains an explicit interactive console
// action, so the service lane refuses --login and requires an explicit config
// path before the dispatcher is entered; both refusals are deterministic
// pre-dispatch failures instead of a service that starts and then dies. The
// lane is selected by the caller (--service in the registered ImagePath); it
// never depends on svc.IsWindowsService().
func runServiceHost(configPath string, loginOnly bool) error {
	if loginOnly {
		return errServiceLoginForbidden
	}
	if configPath == "" {
		return errors.New("--config is required")
	}
	return svc.Run(winhelmServiceName, &winhelmServiceHandler{configPath: configPath})
}

// winhelmServiceHandler implements svc.Handler for the ingress. It publishes
// StartPending immediately, Running only after the ingress reports true local
// readiness, and StopPending before shutdown. The svc package owns the
// terminal Stopped transition after Execute returns, so Execute never sends
// Stopped itself.
type winhelmServiceHandler struct {
	configPath string
	run        func(ctx context.Context, ready func()) error

	mu      sync.Mutex
	current svc.Status
}

func (h *winhelmServiceHandler) setStatus(st svc.Status) {
	h.mu.Lock()
	h.current = st
	h.mu.Unlock()
}

func (h *winhelmServiceHandler) currentStatus() svc.Status {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.current
}

func (h *winhelmServiceHandler) runner() func(context.Context, func()) error {
	if h.run != nil {
		return h.run
	}
	configPath := h.configPath
	return func(ctx context.Context, ready func()) error {
		return runIngress(ctx, configPath, false, ready)
	}
}

// Execute drives the handler protocol. Every status send happens on this
// goroutine so StartPending, Running and StopPending can never be reordered.
func (h *winhelmServiceHandler) Execute(_ []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	readyCh := make(chan struct{})
	var readyOnce sync.Once
	ready := func() { readyOnce.Do(func() { close(readyCh) }) }

	runDone := make(chan error, 1)
	go func() { runDone <- h.runner()(ctx, ready) }()

	startPending := svc.Status{State: svc.StartPending, WaitHint: serviceWaitHintMS}
	h.setStatus(startPending)
	changes <- startPending

	var checkpoint uint32
	readyFired := false
	ticker := time.NewTicker(serviceStartPendingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-readyCh:
			readyCh = nil
			readyFired = true
			ticker.Stop()
			running := svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
			h.setStatus(running)
			changes <- running
		case c := <-r:
			switch c.Cmd {
			case svc.Interrogate:
				changes <- h.currentStatus()
			case svc.Stop, svc.Shutdown:
				stopPending := svc.Status{State: svc.StopPending}
				h.setStatus(stopPending)
				changes <- stopPending
				cancel()
				select {
				case <-runDone:
				case <-time.After(serviceStopWaitHardCap):
				}
				return false, 0
			}
		case <-ticker.C:
			if readyFired {
				continue
			}
			checkpoint++
			pending := svc.Status{State: svc.StartPending, CheckPoint: checkpoint, WaitHint: serviceWaitHintMS}
			h.setStatus(pending)
			changes <- pending
		case err := <-runDone:
			if err != nil || !readyFired {
				return false, serviceFailureExitCode
			}
			return false, 0
		}
	}
}
