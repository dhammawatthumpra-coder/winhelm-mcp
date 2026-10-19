package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStateRestartSameStatePasses(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "tailscaled.state"), []byte("non-empty-test-state"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := writeStateMarker(dir, "winhelm-gemini-go-01", "winhelm-gemini-go-01.tailabb39e.ts.net"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := validateStateMarker(dir, "winhelm-gemini-go-01", "winhelm-gemini-go-01.tailabb39e.ts.net"); err != nil {
			t.Fatalf("same-state restart %d failed: %v", i+1, err)
		}
	}
}

func TestStateRestartMissingStateFailsClosed(t *testing.T) {
	dir := t.TempDir()
	if err := writeStateMarker(dir, "winhelm-gemini-go-01", "winhelm-gemini-go-01.tailabb39e.ts.net"); err != nil {
		t.Fatal(err)
	}
	if err := validateStateMarker(dir, "winhelm-gemini-go-01", "winhelm-gemini-go-01.tailabb39e.ts.net"); err == nil {
		t.Fatal("missing tailscaled.state must fail closed")
	}
}

func TestStateRestartEmptyStateFailsClosed(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "tailscaled.state"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := writeStateMarker(dir, "winhelm-gemini-go-01", "winhelm-gemini-go-01.tailabb39e.ts.net"); err != nil {
		t.Fatal(err)
	}
	if err := validateStateMarker(dir, "winhelm-gemini-go-01", "winhelm-gemini-go-01.tailabb39e.ts.net"); err == nil {
		t.Fatal("empty tailscaled.state must fail closed")
	}
}

func TestStateRestartCorruptMarkerFailsClosed(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "tailscaled.state"), []byte("non-empty-test-state"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, stateMarkerName), []byte("{not-json"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := validateStateMarker(dir, "winhelm-gemini-go-01", "winhelm-gemini-go-01.tailabb39e.ts.net"); err == nil {
		t.Fatal("corrupt marker must fail closed")
	}
}

func TestStateRestartIdentityMismatchFailsClosed(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "tailscaled.state"), []byte("non-empty-test-state"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := writeStateMarker(dir, "other-host", "other-host.tailabb39e.ts.net"); err != nil {
		t.Fatal(err)
	}
	if err := validateStateMarker(dir, "winhelm-gemini-go-01", "winhelm-gemini-go-01.tailabb39e.ts.net"); err == nil {
		t.Fatal("state identity mismatch must fail closed")
	}
}
