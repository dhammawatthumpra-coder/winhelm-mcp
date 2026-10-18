package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestNoALPNHTTP11DeviationLoggedOncePerConnection(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer backend.Close()
	u, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}

	var buf bytes.Buffer
	logger := newEventLogger(&buf)
	h := newProxy(u, logger)
	meta := &connMeta{id: 42, alpn: ""}

	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodGet, "https://example.test/mcp", nil)
		req = req.WithContext(context.WithValue(req.Context(), connMetaKey{}, meta))
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusNoContent {
			t.Fatalf("status=%d", rr.Code)
		}
	}

	out := buf.String()
	if got := strings.Count(out, `"event":"PROTOCOL_DEVIATION"`); got != 1 {
		t.Fatalf("deviation event count=%d output=%s", got, out)
	}
	if !strings.Contains(out, "NO_NEGOTIATED_ALPN_HTTP11_OBSERVED") {
		t.Fatal("deviation class missing")
	}
}

func TestNegotiatedHTTP11DoesNotEmitNoALPNDeviation(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer backend.Close()
	u, err := url.Parse(backend.URL)
	if err != nil {
		t.Fatal(err)
	}

	var buf bytes.Buffer
	logger := newEventLogger(&buf)
	h := newProxy(u, logger)
	meta := &connMeta{id: 43, alpn: "http/1.1"}

	req := httptest.NewRequest(http.MethodGet, "https://example.test/mcp", nil)
	req = req.WithContext(context.WithValue(req.Context(), connMetaKey{}, meta))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	_, _ = io.Copy(io.Discard, rr.Result().Body)
	if strings.Contains(buf.String(), `"event":"PROTOCOL_DEVIATION"`) {
		t.Fatal("unexpected deviation event for negotiated http/1.1")
	}
}
