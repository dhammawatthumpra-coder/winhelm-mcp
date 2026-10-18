package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/tsnet"
)

var version = "dev"

var hostRE = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
var bootstrapRE = regexp.MustCompile(`^/oauth/bootstrap/whr7bi_[A-Za-z0-9_-]{43}$`)
var pctDotRE = regexp.MustCompile(`(?i)%2e`)
var runtimeGenerationRE = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type config struct {
	Version                         int    `json:"version"`
	Host                            string `json:"host"`
	ExpectedPublicHost              string `json:"expectedPublicHost"`
	StateRoot                       string `json:"stateRoot"`
	LogRoot                         string `json:"logRoot"`
	LogMaxBytes                     int64  `json:"logMaxBytes"`
	LogRetentionDays                int    `json:"logRetentionDays"`
	ServiceIdentity                 string `json:"serviceIdentity"`
	Listen                          string `json:"listen"`
	ListenMode                      string `json:"listenMode,omitempty"`
	PreferredPort                   int    `json:"preferredPort,omitempty"`
	Upstream                        string `json:"upstream"`
	CertRefreshSeconds              int    `json:"certRefreshSeconds"`
	CertRefreshTimeoutSeconds       int    `json:"certRefreshTimeoutSeconds"`
	CertFailClosedThresholdSeconds  int    `json:"certFailClosedThresholdSeconds"`
	CertRetryInitialSeconds         int    `json:"certRetryInitialSeconds"`
	CertRetryMaxSeconds             int    `json:"certRetryMaxSeconds"`
	TLSHandshakeTimeoutMS           int    `json:"tlsHandshakeTimeoutMs"`
	ReadHeaderTimeoutMS             int    `json:"readHeaderTimeoutMs"`
	IdleTimeoutMS                   int    `json:"idleTimeoutMs"`
	MaxHeaderBytes                  int    `json:"maxHeaderBytes"`
	BodyReadTimeoutMS               int    `json:"bodyReadTimeoutMs"`
	MCPBodyReadTimeoutMS            int    `json:"mcpBodyReadTimeoutMs"`
	MetadataMaxBodyBytes            int64  `json:"metadataMaxBodyBytes"`
	OAuthFormMaxBodyBytes           int64  `json:"oauthFormMaxBodyBytes"`
	TokenMaxBodyBytes               int64  `json:"tokenMaxBodyBytes"`
	MCPMaxBodyBytes                 int64  `json:"mcpMaxBodyBytes"`
	UpstreamDialTimeoutMS           int    `json:"upstreamDialTimeoutMs"`
	UpstreamKeepAliveMS             int    `json:"upstreamKeepAliveMs"`
	UpstreamMaxIdleConns            int    `json:"upstreamMaxIdleConns"`
	UpstreamMaxIdleConnsPerHost     int    `json:"upstreamMaxIdleConnsPerHost"`
	UpstreamMaxConnsPerHost         int    `json:"upstreamMaxConnsPerHost"`
	UpstreamIdleConnTimeoutMS       int    `json:"upstreamIdleConnTimeoutMs"`
	UpstreamResponseHeaderTimeoutMS int    `json:"upstreamResponseHeaderTimeoutMs"`
	StartupTimeoutMS                int    `json:"startupTimeoutMs"`
	ControlPlaneTimeoutMS           int    `json:"controlPlaneTimeoutMs"`
	CleanupTimeoutMS                int    `json:"cleanupTimeoutMs"`
	ShutdownTimeoutMS               int    `json:"shutdownTimeoutMs"`
}

const (
	minDurationMS     = 100
	maxDurationMS     = 10 * 60 * 1000
	maxIdleDurationMS = 24 * 60 * 60 * 1000
	maxSeconds        = 30 * 24 * 60 * 60
	maxBodyBytes      = 64 * 1024 * 1024
)

func strictDecode(raw []byte, out any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(out); err != nil {
		return err
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("config must contain one JSON value")
		}
		return err
	}
	return nil
}

func validateBoundedInt(name string, value, min, max int64) error {
	if value < min || value > max {
		return fmt.Errorf("%s out of range", name)
	}
	return nil
}

func secondsDuration(name string, value int, min, max int64) (time.Duration, error) {
	if err := validateBoundedInt(name, int64(value), min, max); err != nil {
		return 0, err
	}
	return time.Duration(value) * time.Second, nil
}

func millisecondsDuration(name string, value int, min, max int64) (time.Duration, error) {
	if err := validateBoundedInt(name, int64(value), min, max); err != nil {
		return 0, err
	}
	return time.Duration(value) * time.Millisecond, nil
}

func validatePublicHost(host string) error {
	if host == "" || len(host) > 253 || strings.ContainsAny(host, "/\\:") {
		return errors.New("expectedPublicHost is invalid")
	}
	for _, label := range strings.Split(host, ".") {
		if !hostRE.MatchString(label) {
			return errors.New("expectedPublicHost is invalid")
		}
	}
	return nil
}

func pathWithin(root, candidate string) bool {
	root = filepath.Clean(root)
	candidate = filepath.Clean(candidate)
	rel, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

func loadConfig(raw string) (config, string, *url.URL, error) {
	var cfg config
	if strings.TrimSpace(raw) == "" {
		return cfg, "", nil, errors.New("--config is required")
	}
	abs, err := filepath.Abs(raw)
	if err != nil {
		return cfg, "", nil, err
	}
	b, err := os.ReadFile(abs)
	if err != nil {
		return cfg, "", nil, err
	}
	if err := strictDecode(b, &cfg); err != nil {
		return cfg, "", nil, err
	}
	if cfg.Version != 1 {
		return cfg, "", nil, errors.New("config version must be 1")
	}
	cfg.Host = strings.ToLower(strings.TrimSpace(cfg.Host))
	if !hostRE.MatchString(cfg.Host) {
		return cfg, "", nil, fmt.Errorf("invalid host %q", cfg.Host)
	}
	cfg.ExpectedPublicHost = strings.ToLower(strings.TrimSpace(cfg.ExpectedPublicHost))
	if err := validatePublicHost(cfg.ExpectedPublicHost); err != nil {
		return cfg, "", nil, err
	}
	if strings.TrimSpace(cfg.ServiceIdentity) == "" || strings.ContainsAny(cfg.ServiceIdentity, "\r\n") {
		return cfg, "", nil, errors.New("serviceIdentity is required")
	}
	if _, err := listenPlanFromConfig(cfg); err != nil {
		return cfg, "", nil, err
	}
	u, err := url.Parse(cfg.Upstream)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return cfg, "", nil, errors.New("upstream must be http://127.0.0.1:<port>")
	}
	if err := validatePort(u.Port()); err != nil {
		return cfg, "", nil, fmt.Errorf("upstream: %w", err)
	}
	if !filepath.IsAbs(cfg.StateRoot) {
		cfg.StateRoot = filepath.Clean(filepath.Join(filepath.Dir(abs), cfg.StateRoot))
	}
	if !pathWithin(filepath.Dir(abs), cfg.StateRoot) {
		return cfg, "", nil, errors.New("stateRoot must remain under the config root")
	}
	if !filepath.IsAbs(cfg.LogRoot) {
		cfg.LogRoot = filepath.Clean(filepath.Join(filepath.Dir(abs), cfg.LogRoot))
	}
	if !pathWithin(filepath.Dir(abs), cfg.LogRoot) {
		return cfg, "", nil, errors.New("logRoot must remain under the config root")
	}
	if err := rejectReparsePath(cfg.StateRoot); err != nil {
		return cfg, "", nil, err
	}
	if err := rejectReparsePath(cfg.LogRoot); err != nil {
		return cfg, "", nil, err
	}
	if _, err := secondsDuration("certRefreshSeconds", cfg.CertRefreshSeconds, 1, maxSeconds); err != nil {
		return cfg, "", nil, err
	}
	certRefreshTimeout, err := secondsDuration("certRefreshTimeoutSeconds", cfg.CertRefreshTimeoutSeconds, 1, 10*60)
	if err != nil {
		return cfg, "", nil, err
	}
	failClosed, err := secondsDuration("certFailClosedThresholdSeconds", cfg.CertFailClosedThresholdSeconds, 1, maxSeconds)
	if err != nil {
		return cfg, "", nil, err
	}
	if certRefreshTimeout >= failClosed {
		return cfg, "", nil, errors.New("certificate refresh timeout must be below fail-closed threshold")
	}
	if _, err := secondsDuration("certRetryInitialSeconds", cfg.CertRetryInitialSeconds, 1, 60*60); err != nil {
		return cfg, "", nil, err
	}
	if _, err := secondsDuration("certRetryMaxSeconds", cfg.CertRetryMaxSeconds, 1, 24*60*60); err != nil {
		return cfg, "", nil, err
	}
	if cfg.CertRetryMaxSeconds < cfg.CertRetryInitialSeconds {
		return cfg, "", nil, errors.New("certRetryMaxSeconds must be >= certRetryInitialSeconds")
	}
	if _, err := millisecondsDuration("tlsHandshakeTimeoutMs", cfg.TLSHandshakeTimeoutMS, minDurationMS, maxDurationMS); err != nil {
		return cfg, "", nil, err
	}
	if _, err := millisecondsDuration("readHeaderTimeoutMs", cfg.ReadHeaderTimeoutMS, minDurationMS, maxDurationMS); err != nil {
		return cfg, "", nil, err
	}
	if _, err := millisecondsDuration("idleTimeoutMs", cfg.IdleTimeoutMS, minDurationMS, maxIdleDurationMS); err != nil {
		return cfg, "", nil, err
	}
	if _, err := millisecondsDuration("bodyReadTimeoutMs", cfg.BodyReadTimeoutMS, minDurationMS, maxDurationMS); err != nil {
		return cfg, "", nil, err
	}
	if _, err := millisecondsDuration("mcpBodyReadTimeoutMs", cfg.MCPBodyReadTimeoutMS, minDurationMS, maxDurationMS); err != nil {
		return cfg, "", nil, err
	}
	if cfg.MaxHeaderBytes < 8192 || cfg.MaxHeaderBytes > 1048576 {
		return cfg, "", nil, errors.New("maxHeaderBytes out of range")
	}
	if err := validateBoundedInt("logMaxBytes", cfg.LogMaxBytes, 1024*1024, 64*1024*1024); err != nil {
		return cfg, "", nil, err
	}
	if err := validateBoundedInt("logRetentionDays", int64(cfg.LogRetentionDays), 1, 90); err != nil {
		return cfg, "", nil, err
	}
	if err := validateBoundedInt("metadataMaxBodyBytes", cfg.MetadataMaxBodyBytes, 0, maxBodyBytes); err != nil {
		return cfg, "", nil, err
	}
	for name, value := range map[string]int64{"oauthFormMaxBodyBytes": cfg.OAuthFormMaxBodyBytes, "tokenMaxBodyBytes": cfg.TokenMaxBodyBytes, "mcpMaxBodyBytes": cfg.MCPMaxBodyBytes} {
		if err := validateBoundedInt(name, value, 1, maxBodyBytes); err != nil {
			return cfg, "", nil, err
		}
	}
	for name, value := range map[string]int{"upstreamDialTimeoutMs": cfg.UpstreamDialTimeoutMS, "upstreamKeepAliveMs": cfg.UpstreamKeepAliveMS, "upstreamIdleConnTimeoutMs": cfg.UpstreamIdleConnTimeoutMS, "upstreamResponseHeaderTimeoutMs": cfg.UpstreamResponseHeaderTimeoutMS, "startupTimeoutMs": cfg.StartupTimeoutMS, "controlPlaneTimeoutMs": cfg.ControlPlaneTimeoutMS, "cleanupTimeoutMs": cfg.CleanupTimeoutMS, "shutdownTimeoutMs": cfg.ShutdownTimeoutMS} {
		max := int64(maxDurationMS)
		if name == "upstreamKeepAliveMs" || name == "upstreamIdleConnTimeoutMs" {
			max = maxIdleDurationMS
		}
		if _, err := millisecondsDuration(name, value, minDurationMS, max); err != nil {
			return cfg, "", nil, err
		}
	}
	for name, value := range map[string]int{"upstreamMaxIdleConns": cfg.UpstreamMaxIdleConns, "upstreamMaxIdleConnsPerHost": cfg.UpstreamMaxIdleConnsPerHost, "upstreamMaxConnsPerHost": cfg.UpstreamMaxConnsPerHost} {
		if err := validateBoundedInt(name, int64(value), 1, 1024); err != nil {
			return cfg, "", nil, err
		}
	}
	if cfg.UpstreamMaxIdleConnsPerHost > cfg.UpstreamMaxIdleConns || cfg.UpstreamMaxConnsPerHost < cfg.UpstreamMaxIdleConnsPerHost {
		return cfg, "", nil, errors.New("upstream connection pool invariants failed")
	}
	return cfg, abs, u, nil
}

type stateMarker struct {
	Version    int    `json:"version"`
	Host       string `json:"host"`
	PublicHost string `json:"public_host"`
}

const stateMarkerName = "phase-b-state-marker.json"

func writeStateMarker(stateDir, host, publicHost string) error {
	marker := stateMarker{Version: 1, Host: host, PublicHost: publicHost}
	b, err := json.MarshalIndent(marker, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	if err := rejectReparsePath(stateDir); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(stateDir, "."+stateMarkerName+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	removeTemp := true
	defer func() {
		_ = tmp.Close()
		if removeTemp {
			_ = os.Remove(tmpName)
		}
	}()
	if err := tmp.Chmod(0600); err != nil {
		return err
	}
	if _, err := tmp.Write(b); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := atomicReplaceFile(tmpName, filepath.Join(stateDir, stateMarkerName)); err != nil {
		return err
	}
	removeTemp = false
	return nil
}

func validateStateMarker(stateDir, host, publicHost string) error {
	statePath := filepath.Join(stateDir, "tailscaled.state")
	fi, err := os.Stat(statePath)
	if err != nil {
		return fmt.Errorf("required tsnet state unavailable: %w", err)
	}
	if fi.IsDir() || fi.Size() <= 0 {
		return errors.New("required tsnet state is empty or invalid")
	}
	if err := rejectReparsePath(stateDir); err != nil {
		return err
	}
	b, err := os.ReadFile(filepath.Join(stateDir, stateMarkerName))
	if err != nil {
		return fmt.Errorf("state marker unavailable: %w", err)
	}
	var marker stateMarker
	if err := strictDecode(b, &marker); err != nil {
		return fmt.Errorf("state marker corrupt: %w", err)
	}
	if marker.Version != 1 || marker.Host != host || !strings.EqualFold(marker.PublicHost, publicHost) {
		return errors.New("state marker identity mismatch")
	}
	return nil
}

func validatePort(s string) error {
	n, err := strconv.Atoi(s)
	if err != nil || n < 1024 || n > 65535 {
		return errors.New("port must be 1024..65535")
	}
	return nil
}

const (
	listenModeFixed = "fixed"
	listenModeAuto  = "auto"
)

type internalListenPlan struct {
	mode          string
	host          string
	fixedPort     int
	preferredPort int
}

func listenPlanFromConfig(cfg config) (internalListenPlan, error) {
	host, rawPort, err := net.SplitHostPort(cfg.Listen)
	if err != nil || host != "127.0.0.1" {
		return internalListenPlan{}, errors.New("listen must be 127.0.0.1:<port>")
	}

	mode := strings.ToLower(strings.TrimSpace(cfg.ListenMode))
	if mode == "" {
		mode = listenModeFixed
	}

	switch mode {
	case listenModeFixed:
		if cfg.PreferredPort != 0 {
			return internalListenPlan{}, errors.New("preferredPort is only valid in auto listen mode")
		}
		if err := validatePort(rawPort); err != nil {
			return internalListenPlan{}, fmt.Errorf("listen: %w", err)
		}
		port, _ := strconv.Atoi(rawPort)
		return internalListenPlan{
			mode:      listenModeFixed,
			host:      host,
			fixedPort: port,
		}, nil
	case listenModeAuto:
		if rawPort != "0" {
			return internalListenPlan{}, errors.New("auto listen mode requires 127.0.0.1:0")
		}
		if cfg.PreferredPort != 0 {
			if err := validatePort(strconv.Itoa(cfg.PreferredPort)); err != nil {
				return internalListenPlan{}, fmt.Errorf("preferredPort: %w", err)
			}
		}
		return internalListenPlan{
			mode:          listenModeAuto,
			host:          host,
			preferredPort: cfg.PreferredPort,
		}, nil
	default:
		return internalListenPlan{}, errors.New("listenMode must be fixed or auto")
	}
}

func addressInUseError(err error) bool {
	if errors.Is(err, syscall.EADDRINUSE) {
		return true
	}
	var opErr *net.OpError
	if !errors.As(err, &opErr) {
		return false
	}
	var sysErr *os.SyscallError
	if !errors.As(opErr.Err, &sysErr) {
		return false
	}
	errno, ok := sysErr.Err.(syscall.Errno)
	return ok && errno == syscall.Errno(10048)
}

func bindInternalListener(plan internalListenPlan) (net.Listener, error) {
	if plan.host != "127.0.0.1" {
		return nil, errors.New("internal listener must remain on 127.0.0.1")
	}
	if plan.mode == listenModeFixed {
		return net.Listen("tcp", net.JoinHostPort(plan.host, strconv.Itoa(plan.fixedPort)))
	}
	if plan.mode != listenModeAuto {
		return nil, errors.New("invalid internal listen mode")
	}

	if plan.preferredPort != 0 {
		listener, err := net.Listen(
			"tcp",
			net.JoinHostPort(plan.host, strconv.Itoa(plan.preferredPort)),
		)
		if err == nil {
			return listener, nil
		}
		if !addressInUseError(err) {
			return nil, err
		}
	}
	return net.Listen("tcp", net.JoinHostPort(plan.host, "0"))
}

const runtimeGenerationHeader = "X-WinHelm-Runtime-Generation"

func runtimeHealthHandler(next http.Handler, generation string, pid int) http.Handler {
	if generation == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/health" {
			if r.Header.Get(runtimeGenerationHeader) != generation {
				w.Header().Set("Cache-Control", "no-store")
				w.Header().Set("X-Content-Type-Options", "nosniff")
				w.WriteHeader(http.StatusNotFound)
				return
			}
			payload := map[string]any{
				"status": "ok",
				"server": "winhelm-r8",
				"runtime": map[string]any{
					"role":       "r8",
					"generation": generation,
					"pid":        pid,
				},
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			_ = json.NewEncoder(w).Encode(payload)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type eventLogger struct {
	runID string
	seq   atomic.Uint64
	mu    sync.Mutex
	w     io.Writer
}

type rotatingWriter struct {
	mu            sync.Mutex
	root          string
	path          string
	backup        string
	maxBytes      int64
	retentionDays int
	file          *os.File
	size          int64
}

func newRotatingWriter(root string, maxBytes int64, retentionDays int) (*rotatingWriter, error) {
	if err := rejectReparsePath(root); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	if err := rejectReparsePath(root); err != nil {
		return nil, err
	}
	path := filepath.Join(root, "winhelm-go-tls-ingress.jsonl")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return nil, err
	}
	w := &rotatingWriter{
		root:          root,
		path:          path,
		backup:        path + ".1",
		maxBytes:      maxBytes,
		retentionDays: retentionDays,
		file:          file,
		size:          info.Size(),
	}
	if old, err := os.Stat(w.backup); err == nil && old.ModTime().Add(time.Duration(retentionDays)*24*time.Hour).Before(time.Now()) {
		_ = os.Remove(w.backup)
	}
	return w, nil
}

func (w *rotatingWriter) rotateLocked() error {
	if err := w.file.Close(); err != nil {
		return err
	}
	_ = os.Remove(w.backup)
	if err := os.Rename(w.path, w.backup); err != nil && !os.IsNotExist(err) {
		return err
	}
	file, err := os.OpenFile(w.path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	w.file = file
	w.size = 0
	return nil
}

func (w *rotatingWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if int64(len(p)) > w.maxBytes || w.size > 0 && w.size+int64(len(p)) > w.maxBytes {
		if err := w.rotateLocked(); err != nil {
			return 0, err
		}
	}
	n, err := w.file.Write(p)
	w.size += int64(n)
	return n, err
}

func (w *rotatingWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return nil
	}
	err := w.file.Close()
	w.file = nil
	return err
}

func newEventLogger(w io.Writer) *eventLogger {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return &eventLogger{runID: hex.EncodeToString(b[:]), w: w}
}

func (l *eventLogger) emit(event string, fields map[string]any) {
	rec := map[string]any{
		"run_id":    l.runID,
		"event_seq": l.seq.Add(1),
		"event":     event,
	}
	for k, v := range fields {
		rec[k] = v
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	_ = json.NewEncoder(l.w).Encode(rec)
}

func nodePathname(target string) string {
	path := target
	if i := strings.IndexByte(path, '?'); i >= 0 {
		path = path[:i]
	}
	if path == "" {
		path = "/"
	}
	parts := strings.Split(path, "/")
	out := make([]string, 0, len(parts))
	for _, seg := range parts {
		if seg == "" {
			if len(out) == 0 {
				out = append(out, "")
			}
			continue
		}
		dotNormalized := pctDotRE.ReplaceAllString(seg, ".")
		switch dotNormalized {
		case ".":
			continue
		case "..":
			if len(out) > 1 {
				out = out[:len(out)-1]
			}
			continue
		default:
			out = append(out, seg)
		}
	}
	if len(out) == 0 {
		return "/"
	}
	p := strings.Join(out, "/")
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	if strings.HasSuffix(path, "/") && p != "/" {
		p += "/"
	}
	return p
}

func classifyTarget(target string) string {
	p := nodePathname(target)
	switch p {
	case "/mcp":
		return "MCP"
	case "/.well-known/oauth-authorization-server":
		return "OAUTH_METADATA_AS"
	case "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp":
		return "OAUTH_METADATA_PR"
	case "/oauth/authorize":
		return "OAUTH_AUTHORIZE"
	case "/oauth/token":
		return "OAUTH_TOKEN"
	case "/oauth/register":
		return "OAUTH_REGISTER"
	case "/oauth/revoke":
		return "OAUTH_REVOKE"
	case "/":
		return "ROOT"
	default:
		if bootstrapRE.MatchString(p) {
			return "OAUTH_BOOTSTRAP"
		}
		return "UNKNOWN"
	}
}

type certificateGetter interface {
	GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error)
}

type certificateSource interface {
	Refresh(context.Context, string) (*tls.Certificate, error)
}

type tsnetCertificateSource struct {
	getter certificateGetter
}

func (s tsnetCertificateSource) Refresh(ctx context.Context, serverName string) (*tls.Certificate, error) {
	_ = ctx
	return s.getter.GetCertificate(&tls.ClientHelloInfo{ServerName: serverName})
}

type certState struct {
	cert          tls.Certificate
	leaf          *x509.Certificate
	lastRefreshOK bool
	refreshedAt   time.Time
}

type certManager struct {
	source          certificateSource
	serverName      string
	roots           *x509.CertPool
	refreshTimeout  time.Duration
	failClosedBelow time.Duration
	now             func() time.Time
	state           atomic.Pointer[certState]
	refreshMu       sync.Mutex
	refreshInFlight bool
	refreshDone     chan error
}

func newCertManager(src certificateSource, serverName string, roots *x509.CertPool, refreshTimeout, failClosedBelow time.Duration) *certManager {
	return &certManager{
		source:          src,
		serverName:      serverName,
		roots:           roots,
		refreshTimeout:  refreshTimeout,
		failClosedBelow: failClosedBelow,
		now:             time.Now,
	}
}

func (m *certManager) markRefreshFailure() {
	old := m.state.Load()
	if old == nil {
		return
	}
	next := *old
	next.lastRefreshOK = false
	m.state.Store(&next)
}

func (m *certManager) performRefresh(ctx context.Context) error {
	cert, err := m.source.Refresh(ctx, m.serverName)
	if err != nil {
		m.markRefreshFailure()
		return err
	}
	leaf, err := validateCertificate(cert, m.serverName, m.roots, m.now())
	if err != nil {
		m.markRefreshFailure()
		return err
	}
	copyCert := *cert
	copyCert.Leaf = leaf
	m.state.Store(&certState{
		cert:          copyCert,
		leaf:          leaf,
		lastRefreshOK: true,
		refreshedAt:   m.now(),
	})
	return nil
}

func (m *certManager) refresh(parent context.Context) error {
	m.refreshMu.Lock()
	if m.refreshInFlight {
		done := m.refreshDone
		m.refreshMu.Unlock()
		waitCtx, cancel := context.WithTimeout(parent, m.refreshTimeout)
		defer cancel()
		select {
		case err := <-done:
			return err
		case <-waitCtx.Done():
			return waitCtx.Err()
		}
	}
	done := make(chan error, 1)
	m.refreshInFlight = true
	m.refreshDone = done
	m.refreshMu.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), m.refreshTimeout)
		err := m.performRefresh(ctx)
		cancel()
		done <- err
		close(done)
		m.refreshMu.Lock()
		m.refreshInFlight = false
		m.refreshDone = nil
		m.refreshMu.Unlock()
	}()

	waitCtx, cancel := context.WithTimeout(parent, m.refreshTimeout)
	defer cancel()
	select {
	case err := <-done:
		return err
	case <-waitCtx.Done():
		return waitCtx.Err()
	}
}

func validateCertificate(cert *tls.Certificate, serverName string, roots *x509.CertPool, now time.Time) (*x509.Certificate, error) {
	if cert == nil || len(cert.Certificate) == 0 || cert.PrivateKey == nil {
		return nil, errors.New("certificate incomplete")
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return nil, fmt.Errorf("parse leaf: %w", err)
	}
	if now.Before(leaf.NotBefore) || !now.Before(leaf.NotAfter) {
		return nil, errors.New("certificate outside validity period")
	}
	if err := leaf.VerifyHostname(serverName); err != nil {
		return nil, fmt.Errorf("hostname verify: %w", err)
	}
	intermediates := x509.NewCertPool()
	for _, der := range cert.Certificate[1:] {
		c, err := x509.ParseCertificate(der)
		if err != nil {
			return nil, fmt.Errorf("parse chain: %w", err)
		}
		intermediates.AddCert(c)
	}
	opts := x509.VerifyOptions{
		DNSName:       serverName,
		Intermediates: intermediates,
		Roots:         roots,
		CurrentTime:   now,
	}
	if _, err := leaf.Verify(opts); err != nil {
		return nil, fmt.Errorf("chain verify: %w", err)
	}
	return leaf, nil
}

func (m *certManager) getCertificate(chi *tls.ClientHelloInfo) (*tls.Certificate, error) {
	if chi == nil || !strings.EqualFold(strings.TrimSpace(chi.ServerName), m.serverName) {
		return nil, errors.New("SNI mismatch")
	}
	st := m.state.Load()
	if st == nil || st.leaf == nil {
		return nil, errors.New("no valid certificate snapshot")
	}
	now := m.now()
	if !now.Before(st.leaf.NotAfter) {
		return nil, errors.New("certificate expired")
	}
	if st.leaf.NotAfter.Sub(now) <= m.failClosedBelow && !st.lastRefreshOK {
		return nil, errors.New("certificate refresh unhealthy inside fail-closed threshold")
	}
	return &st.cert, nil
}

func retryDelay(initial, max time.Duration, failures int) time.Duration {
	if initial <= 0 {
		initial = time.Second
	}
	if max < initial {
		max = initial
	}
	delay := initial
	for i := 0; i < failures && delay < max; i++ {
		if delay > max/2 {
			return max
		}
		delay *= 2
	}
	if delay > max {
		return max
	}
	return delay
}

var errOperationTimeout = errors.New("bounded operation timeout")

func runBounded(parent context.Context, timeout time.Duration, operation func(context.Context) error) error {
	if timeout <= 0 {
		return errOperationTimeout
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- operation(ctx)
	}()
	select {
	case err := <-result:
		return err
	case <-ctx.Done():
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return errOperationTimeout
		}
		return ctx.Err()
	}
}

func bodyPoliciesFromConfig(cfg config) map[string]routeBodyPolicy {
	return map[string]routeBodyPolicy{
		"NO_BODY":         {maxBytes: cfg.MetadataMaxBodyBytes, readTimeout: time.Duration(cfg.BodyReadTimeoutMS) * time.Millisecond},
		"OAUTH_AUTHORIZE": {maxBytes: cfg.OAuthFormMaxBodyBytes, readTimeout: time.Duration(cfg.BodyReadTimeoutMS) * time.Millisecond},
		"OAUTH_BOOTSTRAP": {maxBytes: cfg.OAuthFormMaxBodyBytes, readTimeout: time.Duration(cfg.BodyReadTimeoutMS) * time.Millisecond},
		"OAUTH_TOKEN":     {maxBytes: cfg.TokenMaxBodyBytes, readTimeout: time.Duration(cfg.BodyReadTimeoutMS) * time.Millisecond},
		"OAUTH_REGISTER":  {maxBytes: cfg.TokenMaxBodyBytes, readTimeout: time.Duration(cfg.BodyReadTimeoutMS) * time.Millisecond},
		"OAUTH_REVOKE":    {maxBytes: cfg.TokenMaxBodyBytes, readTimeout: time.Duration(cfg.BodyReadTimeoutMS) * time.Millisecond},
		"MCP":             {maxBytes: cfg.MCPMaxBodyBytes, readTimeout: time.Duration(cfg.MCPBodyReadTimeoutMS) * time.Millisecond},
		"UNKNOWN":         {maxBytes: cfg.TokenMaxBodyBytes, readTimeout: time.Duration(cfg.BodyReadTimeoutMS) * time.Millisecond},
		"ROOT":            {maxBytes: cfg.TokenMaxBodyBytes, readTimeout: time.Duration(cfg.BodyReadTimeoutMS) * time.Millisecond},
	}
}

func (m *certManager) runRefreshLoop(ctx context.Context, interval time.Duration, logger *eventLogger, retry ...time.Duration) {
	retryInitial := interval / 8
	if len(retry) > 0 && retry[0] > 0 {
		retryInitial = retry[0]
	}
	retryMax := interval / 2
	if len(retry) > 1 && retry[1] > 0 {
		retryMax = retry[1]
	}
	if retryMax < retryInitial {
		retryMax = retryInitial
	}
	failures := 0
	t := time.NewTimer(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := m.refresh(ctx); err != nil {
				if ctx.Err() != nil {
					return
				}
				failures++
				logger.emit("CERT_REFRESH_FAILED", map[string]any{"class": "refresh_error", "retry_failure": failures})
				t.Reset(retryDelay(retryInitial, retryMax, failures-1))
			} else {
				failures = 0
				logger.emit("CERT_REFRESH_OK", nil)
				t.Reset(interval)
			}
		}
	}
}

type connMetaKey struct{}

type connMeta struct {
	id              uint64
	alpn            string
	deviationLogged atomic.Bool
}

type connTracker struct {
	next   atomic.Uint64
	mu     sync.Mutex
	metas  map[net.Conn]*connMeta
	logger *eventLogger
}

func newConnTracker(logger *eventLogger) *connTracker {
	return &connTracker{metas: make(map[net.Conn]*connMeta), logger: logger}
}

func (t *connTracker) bind(c net.Conn) *connMeta {
	t.mu.Lock()
	defer t.mu.Unlock()
	if meta, ok := t.metas[c]; ok {
		return meta
	}
	meta := &connMeta{id: t.next.Add(1)}
	t.metas[c] = meta
	return meta
}

func (t *connTracker) setALPN(c net.Conn, alpn string) {
	t.mu.Lock()
	if meta, ok := t.metas[c]; ok {
		meta.alpn = alpn
	}
	t.mu.Unlock()
}

func (t *connTracker) forget(c net.Conn) {
	t.mu.Lock()
	delete(t.metas, c)
	if observed, ok := c.(*observingTLSConn); ok {
		for known := range t.metas {
			if other, ok := known.(*observingTLSConn); ok && other.conn == observed.conn {
				delete(t.metas, known)
			}
		}
	}
	t.mu.Unlock()
}

func (t *connTracker) connContext(ctx context.Context, c net.Conn) context.Context {
	return context.WithValue(ctx, connMetaKey{}, t.bind(c))
}

func connMetaFromRequest(r *http.Request) *connMeta {
	if v := r.Context().Value(connMetaKey{}); v != nil {
		if meta, ok := v.(*connMeta); ok {
			return meta
		}
	}
	return nil
}

func connIDFromRequest(r *http.Request) uint64 {
	if meta := connMetaFromRequest(r); meta != nil {
		return meta.id
	}
	return 0
}

type observingTLSListener struct {
	net.Listener
	config           *tls.Config
	handshakeTimeout time.Duration
	tracker          *connTracker
}

type observingTLSConn struct {
	conn             *tls.Conn
	tracker          *connTracker
	id               uint64
	handshakeTimeout time.Duration
	handshakeOnce    sync.Once
	handshakeErr     error
	deadlineMu       sync.Mutex
	readDeadline     time.Time
	writeDeadline    time.Time
}

func (c *observingTLSConn) ensureHandshake() error {
	c.handshakeOnce.Do(func() {
		now := time.Now()
		handshakeDeadline := now.Add(c.handshakeTimeout)
		c.deadlineMu.Lock()
		readDeadline := c.readDeadline
		writeDeadline := c.writeDeadline
		effectiveDeadline := handshakeDeadline
		if !readDeadline.IsZero() && readDeadline.Before(effectiveDeadline) {
			effectiveDeadline = readDeadline
		}
		if !writeDeadline.IsZero() && writeDeadline.Before(effectiveDeadline) {
			effectiveDeadline = writeDeadline
		}
		c.deadlineMu.Unlock()
		_ = c.conn.SetDeadline(effectiveDeadline)
		ctx, cancel := context.WithTimeout(context.Background(), c.handshakeTimeout)
		defer cancel()
		if err := c.conn.HandshakeContext(ctx); err != nil {
			c.handshakeErr = err
			c.tracker.logger.emit("TLS_CLIENT_ERROR", map[string]any{"conn_seq": c.id})
			c.tracker.forget(c)
			_ = c.conn.Close()
			return
		}
		_ = c.conn.SetReadDeadline(readDeadline)
		_ = c.conn.SetWriteDeadline(writeDeadline)
		st := c.conn.ConnectionState()
		c.tracker.setALPN(c, st.NegotiatedProtocol)
		var alpn any
		if st.NegotiatedProtocol != "" {
			alpn = st.NegotiatedProtocol
		}
		c.tracker.logger.emit("TLS_HANDSHAKE", map[string]any{
			"conn_seq":    c.id,
			"tls_version": tlsVersionName(st.Version),
			"cipher":      tls.CipherSuiteName(st.CipherSuite),
			"alpn":        alpn,
			"sni_match":   strings.EqualFold(st.ServerName, expectedSNIValue()),
		})
	})
	return c.handshakeErr
}

func (c *observingTLSConn) Read(p []byte) (int, error) {
	if err := c.ensureHandshake(); err != nil {
		return 0, err
	}
	return c.conn.Read(p)
}

func (c *observingTLSConn) Write(p []byte) (int, error) {
	if err := c.ensureHandshake(); err != nil {
		return 0, err
	}
	return c.conn.Write(p)
}

func (c *observingTLSConn) Close() error {
	c.tracker.forget(c)
	return c.conn.Close()
}

func (c *observingTLSConn) LocalAddr() net.Addr { return c.conn.LocalAddr() }

func (c *observingTLSConn) RemoteAddr() net.Addr { return c.conn.RemoteAddr() }

func (c *observingTLSConn) SetDeadline(deadline time.Time) error {
	c.deadlineMu.Lock()
	c.readDeadline = deadline
	c.writeDeadline = deadline
	c.deadlineMu.Unlock()
	return c.conn.SetDeadline(deadline)
}

func (c *observingTLSConn) SetReadDeadline(deadline time.Time) error {
	c.deadlineMu.Lock()
	c.readDeadline = deadline
	c.deadlineMu.Unlock()
	return c.conn.SetReadDeadline(deadline)
}

func (c *observingTLSConn) SetWriteDeadline(deadline time.Time) error {
	c.deadlineMu.Lock()
	c.writeDeadline = deadline
	c.deadlineMu.Unlock()
	return c.conn.SetWriteDeadline(deadline)
}

func (l *observingTLSListener) Accept() (net.Conn, error) {
	raw, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	tc := &observingTLSConn{
		conn:             tls.Server(raw, l.config),
		tracker:          l.tracker,
		handshakeTimeout: l.handshakeTimeout,
	}
	tc.id = l.tracker.bind(tc).id
	return tc, nil
}

var expectedSNI atomic.Value

func expectedSNIValue() string {
	if v := expectedSNI.Load(); v != nil {
		return v.(string)
	}
	return ""
}

func tlsVersionName(v uint16) string {
	switch v {
	case tls.VersionTLS12:
		return "TLSv1.2"
	case tls.VersionTLS13:
		return "TLSv1.3"
	default:
		return fmt.Sprintf("0x%04x", v)
	}
}

func newTLSConfig(manager *certManager) *tls.Config {
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
		NextProtos: []string{"http/1.1"},
		GetConfigForClient: func(chi *tls.ClientHelloInfo) (*tls.Config, error) {
			if len(chi.SupportedProtos) == 0 {
				return nil, nil
			}
			for _, proto := range chi.SupportedProtos {
				if proto == "http/1.1" {
					return nil, nil
				}
			}
			return nil, errors.New("no supported ALPN protocol")
		},
		GetCertificate: manager.getCertificate,
	}
}

var hopHeaders = []string{
	"Connection",
	"Proxy-Connection",
	"Keep-Alive",
	"Transfer-Encoding",
	"Upgrade",
}

func stripHopHeaders(h http.Header) {
	for _, k := range hopHeaders {
		h.Del(k)
	}
}

var (
	errRequestBodyTooLarge = errors.New("request body exceeds route limit")
	errRequestBodyTimeout  = errors.New("request body read timeout")
)

type routeBodyPolicy struct {
	maxBytes    int64
	readTimeout time.Duration
}

type proxyOptions struct {
	transport       http.RoundTripper
	bodyPolicies    map[string]routeBodyPolicy
	bodyReadTimeout time.Duration
	mcpReadTimeout  time.Duration
}

func defaultBodyPolicies() map[string]routeBodyPolicy {
	return map[string]routeBodyPolicy{
		"NO_BODY":         {maxBytes: 0, readTimeout: 15 * time.Second},
		"OAUTH_AUTHORIZE": {maxBytes: 64 * 1024, readTimeout: 15 * time.Second},
		"OAUTH_BOOTSTRAP": {maxBytes: 64 * 1024, readTimeout: 15 * time.Second},
		"OAUTH_TOKEN":     {maxBytes: 256 * 1024, readTimeout: 15 * time.Second},
		"OAUTH_REGISTER":  {maxBytes: 256 * 1024, readTimeout: 15 * time.Second},
		"OAUTH_REVOKE":    {maxBytes: 256 * 1024, readTimeout: 15 * time.Second},
		"MCP":             {maxBytes: 8 * 1024 * 1024, readTimeout: 60 * time.Second},
		"UNKNOWN":         {maxBytes: 256 * 1024, readTimeout: 15 * time.Second},
		"ROOT":            {maxBytes: 256 * 1024, readTimeout: 15 * time.Second},
	}
}

func bodyPolicyFor(r *http.Request, opts proxyOptions) routeBodyPolicy {
	class := classifyTarget(r.RequestURI)
	if r.Method == http.MethodGet || r.Method == http.MethodHead || strings.HasPrefix(class, "OAUTH_METADATA") {
		class = "NO_BODY"
	}
	policy, ok := opts.bodyPolicies[class]
	if !ok {
		policy = defaultBodyPolicies()["UNKNOWN"]
	}
	if class == "MCP" && opts.mcpReadTimeout > 0 {
		policy.readTimeout = opts.mcpReadTimeout
	} else if opts.bodyReadTimeout > 0 {
		policy.readTimeout = opts.bodyReadTimeout
	}
	return policy
}

func readRequestBody(w http.ResponseWriter, r *http.Request, policy routeBodyPolicy) error {
	if r.Body == nil || r.Body == http.NoBody {
		return nil
	}
	if policy.maxBytes < 0 || policy.maxBytes >= int64(^uint64(0)>>1) {
		return errors.New("invalid body policy")
	}
	if r.ContentLength > policy.maxBytes {
		_ = r.Body.Close()
		return errRequestBodyTooLarge
	}
	original := r.Body
	result := make(chan struct {
		data []byte
		err  error
	}, 1)
	go func() {
		data, err := io.ReadAll(io.LimitReader(original, policy.maxBytes+1))
		result <- struct {
			data []byte
			err  error
		}{data: data, err: err}
	}()
	timeout := policy.readTimeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	var read struct {
		data []byte
		err  error
	}
	select {
	case read = <-result:
	case <-timer.C:
		_ = original.Close()
		select {
		case <-result:
		case <-time.After(100 * time.Millisecond):
		}
		return errRequestBodyTimeout
	}
	_ = original.Close()
	if read.err != nil {
		return read.err
	}
	if int64(len(read.data)) > policy.maxBytes {
		return errRequestBodyTooLarge
	}
	r.Body = io.NopCloser(bytes.NewReader(read.data))
	r.ContentLength = int64(len(read.data))
	return nil
}

func newUpstreamTransport(cfg config) *http.Transport {
	dialer := &net.Dialer{
		Timeout:   time.Duration(cfg.UpstreamDialTimeoutMS) * time.Millisecond,
		KeepAlive: time.Duration(cfg.UpstreamKeepAliveMS) * time.Millisecond,
	}
	return &http.Transport{
		Proxy:                 nil,
		DialContext:           dialer.DialContext,
		ForceAttemptHTTP2:     false,
		MaxIdleConns:          cfg.UpstreamMaxIdleConns,
		MaxIdleConnsPerHost:   cfg.UpstreamMaxIdleConnsPerHost,
		MaxConnsPerHost:       cfg.UpstreamMaxConnsPerHost,
		IdleConnTimeout:       time.Duration(cfg.UpstreamIdleConnTimeoutMS) * time.Millisecond,
		ResponseHeaderTimeout: time.Duration(cfg.UpstreamResponseHeaderTimeoutMS) * time.Millisecond,
		TLSHandshakeTimeout:   time.Duration(cfg.UpstreamDialTimeoutMS) * time.Millisecond,
	}
}

func newProxy(upstream *url.URL, logger *eventLogger, provided ...proxyOptions) http.Handler {
	opts := proxyOptions{transport: http.DefaultTransport, bodyPolicies: defaultBodyPolicies()}
	if len(provided) > 0 {
		if provided[0].transport != nil {
			opts.transport = provided[0].transport
		}
		if provided[0].bodyPolicies != nil {
			opts.bodyPolicies = provided[0].bodyPolicies
		}
		opts.bodyReadTimeout = provided[0].bodyReadTimeout
		opts.mcpReadTimeout = provided[0].mcpReadTimeout
	}
	proxy := &httputil.ReverseProxy{
		Transport: opts.transport,
		Director: func(req *http.Request) {
			req.URL.Scheme = upstream.Scheme
			req.URL.Host = upstream.Host
			req.Host = upstream.Host
			stripHopHeaders(req.Header)
			req.Header.Del("Forwarded")
			req.Header.Del("X-Forwarded-Host")
			req.Header.Del("X-Forwarded-Proto")
			req.Header["X-Forwarded-For"] = nil
		},
		ModifyResponse: func(resp *http.Response) error {
			stripHopHeaders(resp.Header)
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			w.Header().Set("Content-Type", "text/plain")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusBadGateway)
			_, _ = io.WriteString(w, "upstream unavailable")
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		meta := connMetaFromRequest(r)
		connID := uint64(0)
		if meta != nil {
			connID = meta.id
		}
		logger.emit("HTTP_REQUEST", map[string]any{
			"conn_seq":     connID,
			"http_version": strings.TrimPrefix(r.Proto, "HTTP/"),
			"method":       r.Method,
			"route_class":  classifyTarget(r.RequestURI),
		})
		if meta != nil && meta.alpn == "" && r.ProtoMajor == 1 && r.ProtoMinor == 1 && meta.deviationLogged.CompareAndSwap(false, true) {
			logger.emit("PROTOCOL_DEVIATION", map[string]any{
				"conn_seq": connID,
				"class":    "NO_NEGOTIATED_ALPN_HTTP11_OBSERVED",
			})
		}
		if r.ProtoMajor == 1 && r.ProtoMinor == 0 {
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusHTTPVersionNotSupported)
			return
		}
		if err := readRequestBody(w, r, bodyPolicyFor(r, opts)); err != nil {
			w.Header().Set("Cache-Control", "no-store")
			if errors.Is(err, errRequestBodyTooLarge) {
				w.WriteHeader(http.StatusRequestEntityTooLarge)
				_, _ = io.WriteString(w, "request body too large")
				return
			}
			if errors.Is(err, errRequestBodyTimeout) {
				w.WriteHeader(http.StatusRequestTimeout)
				_, _ = io.WriteString(w, "request body timeout")
				return
			}
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, "invalid request body")
			return
		}
		proxy.ServeHTTP(w, r)
	})
}

func publicHostOf(s *tsnet.Server, statusDNS string) string {
	if d := s.CertDomains(); len(d) > 0 {
		return strings.TrimSuffix(strings.ToLower(d[0]), ".")
	}
	return strings.TrimSuffix(strings.ToLower(statusDNS), ".")
}

// winhelmServiceName is the exact SCM registration name; the native service
// dispatcher and the package installer must agree on it.
const winhelmServiceName = "WinHelmGoTlsIngressHardeningR1"

const (
	publicRoutePort        = 443
	requiredRouteListen    = "127.0.0.1:19447"
	controlDirName         = "control"
	controlRequestName     = "request.json"
	controlStatusName      = "status.json"
	controlRequestMaxBytes = 4096
	controlPollInterval    = 5 * time.Second
)

var (
	errRouteListenMismatch = errors.New("public route requires the exact local listener 127.0.0.1:19447")
	errRouteStillActive    = errors.New("public route still active after apply")
	errRouteApply          = errors.New("public route apply failed")
	errRouteReadback       = errors.New("public route readback failed")
	controlRequestIDRE     = regexp.MustCompile(`^[a-f0-9]{32}$`)
)

// serveConfigClient is the minimal tailscale local-API surface the public
// route controller uses; *local.Client as returned by tsnet satisfies it.
type serveConfigClient interface {
	GetServeConfig(context.Context) (*ipn.ServeConfig, error)
	SetServeConfig(context.Context, *ipn.ServeConfig) error
}

// publicRouteController owns every read and mutation of the tailscale serve
// config. Normal startup only ever confirms the public route is inactive and
// clears a stale route with readback verification; activation is reachable
// exclusively through an explicit admin control request and refuses any local
// listener other than 127.0.0.1:19447.
type publicRouteController struct {
	client     serveConfigClient
	publicHost string
	listen     string
	timeout    time.Duration
	logger     *eventLogger
}

func newPublicRouteController(client serveConfigClient, publicHost, listen string, timeout time.Duration, logger *eventLogger) *publicRouteController {
	return &publicRouteController{client: client, publicHost: publicHost, listen: listen, timeout: timeout, logger: logger}
}

func (c *publicRouteController) routeHostPort() ipn.HostPort {
	return ipn.HostPort(net.JoinHostPort(c.publicHost, strconv.Itoa(publicRoutePort)))
}

// routeActive reports whether any public route exposure is present: the exact
// configured host on port 443, any TCP handler on port 443, or any funnel
// entry at all. The Foreground map (ephemeral serve sessions) is inspected
// with the same predicate so an exposure that only lives in a foreground
// session is never mistaken for inactivity. The dedicated state directory
// must never carry a hidden public route, including one left over by a
// previous instance.
func (c *publicRouteController) routeActive(sc *ipn.ServeConfig) bool {
	if sc == nil {
		return false
	}
	if sc.AllowFunnel[c.routeHostPort()] {
		return true
	}
	if _, ok := sc.TCP[publicRoutePort]; ok {
		return true
	}
	if sc.IsFunnelOn() {
		return true
	}
	for _, fg := range sc.Foreground {
		if c.routeActive(fg) {
			return true
		}
	}
	return false
}

// exactActive verifies the full accepted mapping: funnel on for exactly the
// configured host and port 443, forwarding to exactly the configured listener.
func (c *publicRouteController) exactActive(sc *ipn.ServeConfig) bool {
	if sc == nil {
		return false
	}
	if !sc.AllowFunnel[c.routeHostPort()] {
		return false
	}
	handler := sc.TCP[publicRoutePort]
	return handler != nil && handler.TCPForward == c.listen
}

func (c *publicRouteController) getConfig(ctx context.Context) (*ipn.ServeConfig, error) {
	opCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	return c.client.GetServeConfig(opCtx)
}

func (c *publicRouteController) setConfig(ctx context.Context, sc *ipn.ServeConfig) error {
	opCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	return c.client.SetServeConfig(opCtx, sc)
}

// clearRoute removes the entire serve config and verifies with a readback that
// no public route exposure remains.
func (c *publicRouteController) clearRoute(ctx context.Context, stage string) error {
	if err := c.setConfig(ctx, new(ipn.ServeConfig)); err != nil {
		c.logger.emit("PUBLIC_ROUTE_DEACTIVATION_FAILED", map[string]any{"class": "apply_error", "stage": stage})
		return fmt.Errorf("%w: %v", errRouteApply, err)
	}
	readback, err := c.getConfig(ctx)
	if err != nil {
		c.logger.emit("PUBLIC_ROUTE_DEACTIVATION_FAILED", map[string]any{"class": "readback_error", "stage": stage})
		return fmt.Errorf("%w: %v", errRouteReadback, err)
	}
	if c.routeActive(readback) {
		c.logger.emit("PUBLIC_ROUTE_DEACTIVATION_FAILED", map[string]any{"class": "still_active", "stage": stage})
		return errRouteStillActive
	}
	return nil
}

// ensureInactive is the fail-closed startup gate: the public route must be
// confirmably inactive; a stale route is cleared with readback verification
// and anything unverifiable aborts the caller.
func (c *publicRouteController) ensureInactive(ctx context.Context, stage string) error {
	current, err := c.getConfig(ctx)
	if err != nil {
		c.logger.emit("PUBLIC_ROUTE_CONFIRM_FAILED", map[string]any{"stage": stage, "class": "get_error"})
		return fmt.Errorf("%w: %v", errRouteReadback, err)
	}
	if !c.routeActive(current) {
		c.logger.emit("PUBLIC_ROUTE_CONFIRMED_INACTIVE", map[string]any{"stage": stage, "class": "no_public_route"})
		return nil
	}
	if err := c.clearRoute(ctx, stage); err != nil {
		c.logger.emit("PUBLIC_ROUTE_CONFIRM_FAILED", map[string]any{"stage": stage, "class": "clear_failed"})
		return err
	}
	c.logger.emit("PUBLIC_SERVE_STALE_CLEARED", map[string]any{"stage": stage, "class": "stale_route_cleared"})
	c.logger.emit("PUBLIC_ROUTE_CONFIRMED_INACTIVE", map[string]any{"stage": stage, "class": "no_public_route"})
	return nil
}

// activate applies the exact accepted mapping for an explicitly authorized
// admin request. It never runs during normal startup.
func (c *publicRouteController) activate(ctx context.Context, requestID string) error {
	if c.listen != requiredRouteListen {
		return errRouteListenMismatch
	}
	desired := new(ipn.ServeConfig)
	desired.SetTCPForwarding(publicRoutePort, c.listen, false, 0, "")
	desired.SetFunnel(c.publicHost, publicRoutePort, true)
	if err := c.setConfig(ctx, desired); err != nil {
		c.logger.emit("PUBLIC_ROUTE_ACTIVATION_FAILED", map[string]any{"class": "apply_error", "request_id": requestID})
		return fmt.Errorf("%w: %v", errRouteApply, err)
	}
	readback, err := c.getConfig(ctx)
	if err != nil {
		c.logger.emit("PUBLIC_ROUTE_ACTIVATION_FAILED", map[string]any{"class": "readback_error", "request_id": requestID})
		return fmt.Errorf("%w: %v", errRouteReadback, err)
	}
	if !c.exactActive(readback) {
		c.logger.emit("PUBLIC_ROUTE_ACTIVATION_FAILED", map[string]any{"class": "readback_mismatch", "request_id": requestID})
		return errRouteReadback
	}
	c.logger.emit("PUBLIC_SERVE_ACTIVE", map[string]any{"class": "explicit_admin_activation", "request_id": requestID})
	return nil
}

// deactivate is the explicit bounded cleanup lane for the same admin control
// channel; the stop path reuses clearRoute directly.
func (c *publicRouteController) deactivate(ctx context.Context, requestID string) error {
	if err := c.clearRoute(ctx, "explicit_deactivation"); err != nil {
		return err
	}
	c.logger.emit("PUBLIC_SERVE_INACTIVE", map[string]any{"class": "explicit_admin_deactivation", "request_id": requestID})
	return nil
}

type controlRequest struct {
	Version   int    `json:"version"`
	Action    string `json:"action"`
	RequestID string `json:"request_id"`
}

type controlRequestOutcome struct {
	RequestID string `json:"request_id"`
	Action    string `json:"action"`
	Result    string `json:"result"`
	Class     string `json:"class"`
}

// controlStatus is the sanitized local status surface. It never carries
// credential material, tsnet state content, or unbounded input.
type controlStatus struct {
	Version       int                    `json:"version"`
	UpdatedAt     string                 `json:"updated_at"`
	Service       string                 `json:"service"`
	PublicRoute   string                 `json:"public_route"`
	PublicHost    string                 `json:"public_host"`
	PublicPort    int                    `json:"public_port"`
	LocalListener string                 `json:"local_listener"`
	LastRequest   *controlRequestOutcome `json:"last_request,omitempty"`
}

// controlChannel is the local one-shot admin control path: the admin helper
// writes request.json inside the protected host-state control directory and
// the running ingress, the single tsnet owner for that state directory,
// processes it on a bounded poll interval. No listener or pipe is created.
type controlChannel struct {
	dir         string
	service     string
	publicHost  string
	listen      string
	controller  *publicRouteController
	logger      *eventLogger
	publicRoute string
	lastRequest string
	lastOutcome *controlRequestOutcome
}

func newControlChannel(dir, service, publicHost, listen string, controller *publicRouteController, logger *eventLogger) *controlChannel {
	return &controlChannel{
		dir:         dir,
		service:     service,
		publicHost:  publicHost,
		listen:      listen,
		controller:  controller,
		logger:      logger,
		publicRoute: "inactive",
	}
}

func (cc *controlChannel) requestPath() string { return filepath.Join(cc.dir, controlRequestName) }

func (cc *controlChannel) statusPath() string { return filepath.Join(cc.dir, controlStatusName) }

// discardStaleRequest removes any request that predates this boot. A request
// file present at startup is by definition stale: the admin helper refuses to
// write while the service is not Running, so boot-time activation is
// structurally impossible.
func (cc *controlChannel) discardStaleRequest() {
	if err := os.Remove(cc.requestPath()); err != nil {
		if !os.IsNotExist(err) {
			cc.logger.emit("CONTROL_REQUEST_REJECTED", map[string]any{"class": "stale_request_delete_failed"})
		}
		return
	}
	cc.logger.emit("CONTROL_REQUEST_REJECTED", map[string]any{"class": "stale_request_at_startup"})
}

func readControlRequestFile(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, controlRequestMaxBytes+1))
}

func parseControlRequest(raw []byte) (controlRequest, string) {
	var req controlRequest
	if len(raw) > controlRequestMaxBytes {
		return req, "request_too_large"
	}
	if err := strictDecode(raw, &req); err != nil {
		return req, "invalid_request"
	}
	if req.Version != 1 || !controlRequestIDRE.MatchString(req.RequestID) {
		return req, "invalid_request"
	}
	if req.Action != "activate" && req.Action != "deactivate" {
		return req, "invalid_request"
	}
	return req, ""
}

func classifyControlError(err error) string {
	switch {
	case errors.Is(err, errRouteListenMismatch):
		return "route_listen_mismatch"
	case errors.Is(err, errRouteStillActive):
		return "route_still_active"
	case errors.Is(err, errRouteApply):
		return "route_apply_failed"
	case errors.Is(err, errRouteReadback):
		return "route_readback_failed"
	default:
		return "route_error"
	}
}

// process handles at most one admin control request per poll. The request file
// is deleted before any action runs; when deletion fails the request is
// skipped so a one-shot intent can never be replayed or double-processed.
func (cc *controlChannel) process(ctx context.Context) {
	raw, err := readControlRequestFile(cc.requestPath())
	if err != nil {
		if os.IsNotExist(err) {
			return
		}
		cc.logger.emit("CONTROL_REQUEST_REJECTED", map[string]any{"class": "request_unreadable"})
		return
	}
	req, class := parseControlRequest(raw)
	if class != "" {
		_ = os.Remove(cc.requestPath())
		fields := map[string]any{"class": class}
		if req.RequestID != "" {
			fields["request_id"] = req.RequestID
		}
		cc.logger.emit("CONTROL_REQUEST_REJECTED", fields)
		return
	}
	if err := os.Remove(cc.requestPath()); err != nil {
		cc.logger.emit("CONTROL_REQUEST_REJECTED", map[string]any{"class": "request_delete_failed", "request_id": req.RequestID})
		return
	}
	if req.RequestID == cc.lastRequest {
		cc.logger.emit("CONTROL_REQUEST_REJECTED", map[string]any{"class": "duplicate_request", "request_id": req.RequestID})
		return
	}
	cc.lastRequest = req.RequestID
	var actionErr error
	switch req.Action {
	case "activate":
		actionErr = cc.controller.activate(ctx, req.RequestID)
	case "deactivate":
		actionErr = cc.controller.deactivate(ctx, req.RequestID)
	}
	outcome := &controlRequestOutcome{RequestID: req.RequestID, Action: req.Action, Result: "ok"}
	if actionErr != nil {
		outcome.Result = "error"
		outcome.Class = classifyControlError(actionErr)
	} else if req.Action == "activate" {
		cc.publicRoute = "active"
	} else {
		cc.publicRoute = "inactive"
	}
	cc.lastOutcome = outcome
	cc.logger.emit("CONTROL_REQUEST_PROCESSED", map[string]any{
		"action":     req.Action,
		"result":     outcome.Result,
		"class":      outcome.Class,
		"request_id": req.RequestID,
	})
	if err := cc.writeStatus(); err != nil {
		cc.logger.emit("CONTROL_STATUS_WRITE_FAILED", map[string]any{"class": "runtime"})
	}
}

// writeStatus persists the sanitized status surface atomically inside the
// protected control directory under the same size bound as the request schema.
func (cc *controlChannel) writeStatus() error {
	status := controlStatus{
		Version:       1,
		UpdatedAt:     time.Now().UTC().Format(time.RFC3339),
		Service:       cc.service,
		PublicRoute:   cc.publicRoute,
		PublicHost:    cc.publicHost,
		PublicPort:    publicRoutePort,
		LocalListener: cc.listen,
		LastRequest:   cc.lastOutcome,
	}
	b, err := json.MarshalIndent(status, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	if len(b) > controlRequestMaxBytes {
		return errors.New("control status exceeds size bound")
	}
	if err := rejectReparsePath(cc.dir); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(cc.dir, "."+controlStatusName+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	removeTemp := true
	defer func() {
		_ = tmp.Close()
		if removeTemp {
			_ = os.Remove(tmpName)
		}
	}()
	if _, err := tmp.Write(b); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := atomicReplaceFile(tmpName, cc.statusPath()); err != nil {
		return err
	}
	removeTemp = false
	return nil
}

// closeTsnet performs the bounded tsnet shutdown used by every exit path that
// does not reach the steady-state cleanup so the state lock and sockets are
// released promptly.
func closeTsnet(cfg config, srv *tsnet.Server) {
	_ = runBounded(context.Background(), time.Duration(cfg.ShutdownTimeoutMS)*time.Millisecond, func(context.Context) error { return srv.Close() })
}

// runEntrypoint dispatches between the interactive console lane and the native
// Windows service host lane. The production service lane is selected by the
// explicit --service argument carried by the registered service ImagePath and
// enters runServiceHost directly; it never depends on
// svc.IsWindowsService() returning true. The autodetection remains only as a
// secondary hardening net for a non-flagged SCM launch, and its error is
// fail-closed so the process never silently falls back to console behavior
// when SCM context cannot be ruled out.
func runEntrypoint(configPath string, loginOnly, serviceMode bool) error {
	if serviceMode {
		return serviceHostRunner(configPath, loginOnly)
	}
	inService, err := detectWindowsService()
	if err != nil {
		return fmt.Errorf("service detection: %w", err)
	}
	if inService {
		return serviceHostRunner(configPath, loginOnly)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return runIngress(ctx, configPath, loginOnly, nil)
}

func main() {
	configPath := flag.String("config", "", "JSON config")
	loginOnly := flag.Bool("login", false, "perform tsnet login only")
	serviceMode := flag.Bool("service", false, "run as the registered Windows service (set by the service ImagePath)")
	showVersion := flag.Bool("version", false, "show version")
	flag.Parse()

	if *showVersion {
		fmt.Printf("winhelm-go-tls-ingress %s\n", version)
		return
	}

	if err := runEntrypoint(*configPath, *loginOnly, *serviceMode); err != nil {
		log.Fatal(err)
	}
}

func runIngress(ctx context.Context, configPath string, loginOnly bool, ready func()) error {
	cfg, resolvedConfig, upstream, err := loadConfig(configPath)
	if err != nil {
		return err
	}
	listenPlan, err := listenPlanFromConfig(cfg)
	if err != nil {
		return err
	}
	runtimeGeneration := strings.TrimSpace(os.Getenv("WINHELM_R8_RUNTIME_GENERATION"))
	if runtimeGeneration != "" && !runtimeGenerationRE.MatchString(runtimeGeneration) {
		return errors.New("WINHELM_R8_RUNTIME_GENERATION is invalid")
	}
	logWriter, err := newRotatingWriter(cfg.LogRoot, cfg.LogMaxBytes, cfg.LogRetentionDays)
	if err != nil {
		return err
	}
	defer logWriter.Close()
	logger := newEventLogger(logWriter)
	expectedSNI.Store(cfg.ExpectedPublicHost)

	stateDir := filepath.Join(cfg.StateRoot, cfg.Host)
	if err := os.MkdirAll(stateDir, 0700); err != nil {
		return err
	}
	if err := rejectReparsePath(stateDir); err != nil {
		logger.emit("STATE_ACL_REJECTED", map[string]any{"class": "reparse_path"})
		return err
	}
	lock, err := acquireStateLock(stateDir)
	if err != nil {
		logger.emit("DUPLICATE_INSTANCE_REJECTED", map[string]any{"class": "state_lock_conflict"})
		return err
	}
	defer lock.Close()
	logger.emit("STATE_LOCK_ACQUIRED", map[string]any{"class": "exclusive_state_owner"})
	if err := verifyStateACL(stateDir, cfg.ServiceIdentity); err != nil {
		logger.emit("STATE_ACL_REJECTED", map[string]any{"class": "acl_floor"})
		return err
	}
	logger.emit("STATE_ACL_VALIDATED", map[string]any{"class": "acl_floor"})
	if !loginOnly {
		if err := validateStateMarker(stateDir, cfg.Host, cfg.ExpectedPublicHost); err != nil {
			logger.emit("STATE_VALIDATION_FAILED", map[string]any{"class": "marker"})
			return fmt.Errorf("state preflight: %w", err)
		}
		logger.emit("STATE_VALIDATED", map[string]any{"class": "marker_and_identity"})
	}

	srv := &tsnet.Server{
		Hostname: cfg.Host,
		Dir:      stateDir,
		Logf:     func(string, ...any) {},
		UserLogf: func(format string, args ...any) {
			if loginOnly {
				fmt.Fprintf(os.Stderr, format+"\n", args...)
			}
		},
	}
	startupCtx, cancelStartup := context.WithTimeout(ctx, time.Duration(cfg.StartupTimeoutMS)*time.Millisecond)
	status, err := srv.Up(startupCtx)
	cancelStartup()
	if err != nil {
		logger.emit("STARTUP_FAILED", map[string]any{"stage": "tsnet_up"})
		closeTsnet(cfg, srv)
		return fmt.Errorf("tsnet up: %w", err)
	}
	logger.emit("STARTUP_STAGE", map[string]any{"stage": "tsnet_up"})
	statusDNS := ""
	if status.Self != nil {
		statusDNS = status.Self.DNSName
	}
	publicHost := publicHostOf(srv, statusDNS)
	if publicHost == "" {
		logger.emit("STARTUP_FAILED", map[string]any{"stage": "public_host"})
		closeTsnet(cfg, srv)
		return errors.New("public host unavailable")
	}
	if !strings.EqualFold(publicHost, cfg.ExpectedPublicHost) {
		logger.emit("STARTUP_FAILED", map[string]any{"stage": "public_host_match"})
		closeTsnet(cfg, srv)
		return errors.New("public host mismatch")
	}

	if loginOnly {
		if err := writeStateMarker(stateDir, cfg.Host, publicHost); err != nil {
			logger.emit("STARTUP_FAILED", map[string]any{"stage": "state_marker"})
			closeTsnet(cfg, srv)
			return fmt.Errorf("write state marker: %w", err)
		}
		fmt.Printf("{\"event\":\"GO_TLS_LOGIN_OK\",\"host\":%q,\"public_host\":%q}\n", cfg.Host, publicHost)
		logger.emit("ADMIN_ENROLLMENT_COMPLETE", map[string]any{"class": "one_shot_login"})
		closeTsnet(cfg, srv)
		return nil
	}

	lc, err := srv.LocalClient()
	if err != nil {
		logger.emit("STARTUP_FAILED", map[string]any{"stage": "local_client"})
		closeTsnet(cfg, srv)
		return fmt.Errorf("local client: %w", err)
	}

	controlDir := filepath.Join(stateDir, controlDirName)
	if err := os.MkdirAll(controlDir, 0700); err != nil {
		logger.emit("STARTUP_FAILED", map[string]any{"stage": "control_directory"})
		closeTsnet(cfg, srv)
		return fmt.Errorf("control directory: %w", err)
	}
	if err := rejectReparsePath(controlDir); err != nil {
		logger.emit("CONTROL_DIR_REJECTED", map[string]any{"class": "reparse_path"})
		closeTsnet(cfg, srv)
		return err
	}
	if err := verifyACLPath(controlDir, cfg.ServiceIdentity, false); err != nil {
		logger.emit("CONTROL_DIR_REJECTED", map[string]any{"class": "acl_floor"})
		closeTsnet(cfg, srv)
		return err
	}
	control := newControlChannel(
		controlDir,
		winhelmServiceName,
		publicHost,
		cfg.Listen,
		newPublicRouteController(lc, publicHost, cfg.Listen, time.Duration(cfg.ControlPlaneTimeoutMS)*time.Millisecond, logger),
		logger,
	)
	control.discardStaleRequest()
	if err := control.controller.ensureInactive(ctx, "startup_prelisten"); err != nil {
		logger.emit("STARTUP_FAILED", map[string]any{"stage": "public_route_confirmation"})
		closeTsnet(cfg, srv)
		return fmt.Errorf("public route confirmation: %w", err)
	}
	manager := newCertManager(
		tsnetCertificateSource{getter: lc},
		publicHost,
		nil,
		time.Duration(cfg.CertRefreshTimeoutSeconds)*time.Second,
		time.Duration(cfg.CertFailClosedThresholdSeconds)*time.Second,
	)
	if err := manager.refresh(ctx); err != nil {
		logger.emit("STARTUP_FAILED", map[string]any{"stage": "certificate"})
		closeTsnet(cfg, srv)
		return fmt.Errorf("initial certificate refresh: %w", err)
	}
	logger.emit("STARTUP_STAGE", map[string]any{"stage": "certificate"})

	tlsCfg := newTLSConfig(manager)

	baseListener, err := bindInternalListener(listenPlan)
	if err != nil {
		logger.emit("STARTUP_FAILED", map[string]any{"stage": "listen"})
		closeTsnet(cfg, srv)
		return fmt.Errorf("listen: %w", err)
	}
	defer baseListener.Close()
	effectiveListen := baseListener.Addr().String()
	effectiveHost, effectivePort, err := net.SplitHostPort(effectiveListen)
	if err != nil || effectiveHost != "127.0.0.1" {
		closeTsnet(cfg, srv)
		return errors.New("bound R8 listener did not report a loopback TCP endpoint")
	}
	if err := validatePort(effectivePort); err != nil {
		closeTsnet(cfg, srv)
		return fmt.Errorf("bound R8 listener: %w", err)
	}
	cfg.Listen = effectiveListen
	control.listen = effectiveListen
	control.controller.listen = effectiveListen

	tracker := newConnTracker(logger)
	tlsListener := &observingTLSListener{
		Listener:         baseListener,
		config:           tlsCfg,
		handshakeTimeout: time.Duration(cfg.TLSHandshakeTimeoutMS) * time.Millisecond,
		tracker:          tracker,
	}

	proxyHandler := newProxy(upstream, logger, proxyOptions{
		transport:       newUpstreamTransport(cfg),
		bodyPolicies:    bodyPoliciesFromConfig(cfg),
		bodyReadTimeout: time.Duration(cfg.BodyReadTimeoutMS) * time.Millisecond,
		mcpReadTimeout:  time.Duration(cfg.MCPBodyReadTimeoutMS) * time.Millisecond,
	})
	httpServer := &http.Server{
		Handler:           runtimeHealthHandler(proxyHandler, runtimeGeneration, os.Getpid()),
		ReadHeaderTimeout: time.Duration(cfg.ReadHeaderTimeoutMS) * time.Millisecond,
		IdleTimeout:       time.Duration(cfg.IdleTimeoutMS) * time.Millisecond,
		MaxHeaderBytes:    cfg.MaxHeaderBytes,
		ErrorLog:          log.New(io.Discard, "", 0),
		ConnContext:       tracker.connContext,
		ConnState: func(c net.Conn, state http.ConnState) {
			if state == http.StateClosed || state == http.StateHijacked {
				tracker.forget(c)
			}
		},
	}

	serveErr := make(chan error, 1)
	go func() {
		err := httpServer.Serve(tlsListener)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		serveErr <- err
	}()

	if err := control.controller.ensureInactive(ctx, "startup_preready"); err != nil {
		logger.emit("STARTUP_FAILED", map[string]any{"stage": "public_route_reconfirmation"})
		_ = runBounded(context.Background(), time.Duration(cfg.ShutdownTimeoutMS)*time.Millisecond, func(ctx context.Context) error { return httpServer.Shutdown(ctx) })
		closeTsnet(cfg, srv)
		return fmt.Errorf("public route reconfirmation: %w", err)
	}

	go manager.runRefreshLoop(ctx, time.Duration(cfg.CertRefreshSeconds)*time.Second, logger, time.Duration(cfg.CertRetryInitialSeconds)*time.Second, time.Duration(cfg.CertRetryMaxSeconds)*time.Second)

	if err := control.writeStatus(); err != nil {
		logger.emit("CONTROL_STATUS_WRITE_FAILED", map[string]any{"class": "startup"})
	}

	logger.emit("GO_TLS_INGRESS_READY", map[string]any{
		"listener":     cfg.Listen,
		"upstream":     upstream.String(),
		"public_host":  publicHost,
		"public_route": "inactive",
		"config":       resolvedConfig,
	})
	if runtimeGeneration != "" {
		readyEvent, _ := json.Marshal(map[string]any{
			"event":      "R8_DYNAMIC_RUNTIME_READY",
			"listener":   cfg.Listen,
			"upstream":   upstream.String(),
			"generation": runtimeGeneration,
			"pid":        os.Getpid(),
		})
		fmt.Println(string(readyEvent))
	}
	if ready != nil {
		ready()
	}

	var runtimeErr error
	serveDrained := false
	poll := time.NewTicker(controlPollInterval)
	defer poll.Stop()
loop:
	for {
		select {
		case <-ctx.Done():
			logger.emit("GRACEFUL_STOP", map[string]any{"stage": "signal"})
			break loop
		case err := <-serveErr:
			serveDrained = true
			if err != nil {
				logger.emit("GRACEFUL_STOP_FAILED", map[string]any{"class": "serve_error"})
			}
			runtimeErr = err
			break loop
		case <-poll.C:
			control.process(ctx)
		}
	}

	shutdownErr := runBounded(context.Background(), time.Duration(cfg.ShutdownTimeoutMS)*time.Millisecond, func(ctx context.Context) error { return httpServer.Shutdown(ctx) })
	if shutdownErr != nil {
		logger.emit("GRACEFUL_STOP_FAILED", map[string]any{"class": "http_shutdown"})
		_ = httpServer.Close()
	}
	if !serveDrained {
		select {
		case err := <-serveErr:
			if err != nil {
				logger.emit("GRACEFUL_STOP_FAILED", map[string]any{"class": "serve_stop"})
			}
		case <-time.After(time.Duration(cfg.CleanupTimeoutMS) * time.Millisecond):
			logger.emit("CLEANUP_FAILED", map[string]any{"class": "serve_wait"})
		}
	}
	if err := runBounded(context.Background(), time.Duration(cfg.CleanupTimeoutMS)*time.Millisecond, func(ctx context.Context) error {
		return control.controller.clearRoute(ctx, "stop")
	}); err != nil {
		logger.emit("CLEANUP_FAILED", map[string]any{"class": "serve_config_cleanup"})
	} else {
		control.publicRoute = "inactive"
	}
	if err := control.writeStatus(); err != nil {
		logger.emit("CONTROL_STATUS_WRITE_FAILED", map[string]any{"class": "stop"})
	}
	if err := runBounded(context.Background(), time.Duration(cfg.ShutdownTimeoutMS)*time.Millisecond, func(context.Context) error { return srv.Close() }); err != nil {
		logger.emit("CLEANUP_FAILED", map[string]any{"class": "tsnet_shutdown"})
	}
	return runtimeErr
}
