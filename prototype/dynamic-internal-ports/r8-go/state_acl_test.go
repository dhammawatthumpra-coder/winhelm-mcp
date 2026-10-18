//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// aclFixtureIdentity returns the current process account name and SID string.
// The account name is used as the service identity argument because
// windows.LookupSID resolves account names; well-known aliases (SY, BA, ...)
// render as aliases in SDDL text and would break the SID substring check.
func aclFixtureIdentity(t *testing.T) (string, string) {
	t.Helper()
	tu, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatalf("token user: %v", err)
	}
	sid := tu.User.Sid.String()
	name, _, _, err := tu.User.Sid.LookupAccount("")
	if err != nil || name == "" {
		t.Fatalf("account name for %s: %v", sid, err)
	}
	return name, sid
}

// applyDACLDescriptor writes an explicit DACL to path. SetKernelObjectSecurity
// is used because SetNamedSecurityInfo re-materializes parent inheritance and
// silently drops the SE_DACL_PROTECTED flag on protected fixture roots.
func applyDACLDescriptor(t *testing.T, path, sddl string) {
	t.Helper()
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		t.Fatalf("descriptor %q: %v", sddl, err)
	}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(p, windows.WRITE_DAC|windows.READ_CONTROL,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer windows.CloseHandle(h)
	if err := windows.SetKernelObjectSecurity(h, windows.DACL_SECURITY_INFORMATION, sd); err != nil {
		t.Fatalf("apply DACL on %s: %v", path, err)
	}
}

func daclIsProtected(t *testing.T, path string) bool {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil || sd == nil {
		t.Fatalf("read DACL of %s: %v", path, err)
	}
	control, _, err := sd.Control()
	if err != nil {
		t.Fatalf("control of %s: %v", path, err)
	}
	return control&windows.SE_DACL_PROTECTED != 0
}

func safeProtectedSDDL(sid string) string {
	return "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + sid + ")"
}

// protectedStateFixture creates a state root whose DACL is protected and
// safely inheritable (SYSTEM + current user, full access, OI/CI).
func protectedStateFixture(t *testing.T, sid string) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	applyDACLDescriptor(t, root, safeProtectedSDDL(sid))
	if !daclIsProtected(t, root) {
		t.Fatal("fixture root must carry SE_DACL_PROTECTED")
	}
	return root
}

func expectStateACLError(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("want error containing %q, got %v", want, err)
	}
}

// 1. protected safe canonical state root passes.
func TestStateACLProtectedRootPasses(t *testing.T) {
	name, sid := aclFixtureIdentity(t)
	root := protectedStateFixture(t, sid)
	if err := verifyStateACL(root, name); err != nil {
		t.Fatalf("protected safe root must pass: %v", err)
	}
}

// 2. unprotected canonical state root fails.
func TestStateACLUnprotectedRootFails(t *testing.T) {
	name, _ := aclFixtureIdentity(t)
	root := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if daclIsProtected(t, root) {
		t.Fatal("fresh fixture root unexpectedly protected")
	}
	expectStateACLError(t, verifyStateACL(root, name), "ACL inheritance is not protected")
}

// 3. protected root + inherited-safe child passes; the child itself is NOT
// protected, which is exactly the R3 false-negative that R4 corrects.
func TestStateACLInheritedSafeChildPasses(t *testing.T) {
	name, sid := aclFixtureIdentity(t)
	root := protectedStateFixture(t, sid)
	child := filepath.Join(root, "runtime-child")
	if err := os.Mkdir(child, 0o700); err != nil {
		t.Fatal(err)
	}
	if daclIsProtected(t, child) {
		t.Fatal("fixture child must inherit (unprotected) to exercise the corrected semantics")
	}
	if err := verifyStateACL(root, name); err != nil {
		t.Fatalf("inherited-safe child must pass: %v", err)
	}
}

// 4. child whose effective ACL contains a broad writable principal fails.
func TestStateACLChildBroadWriteFails(t *testing.T) {
	name, sid := aclFixtureIdentity(t)
	root := protectedStateFixture(t, sid)
	child := filepath.Join(root, "runtime-child")
	if err := os.Mkdir(child, 0o700); err != nil {
		t.Fatal(err)
	}
	applyDACLDescriptor(t, child, "D:(A;OICI;FA;;;SY)(A;OICI;FA;;;"+sid+")(A;OICI;GW;;;WD)")
	expectStateACLError(t, verifyStateACL(root, name), "ACL broad-write floor failed")
}

// 5. child missing the service SID fails even though its ACL is protected.
func TestStateACLChildMissingServiceSIDFails(t *testing.T) {
	name, sid := aclFixtureIdentity(t)
	root := protectedStateFixture(t, sid)
	child := filepath.Join(root, "runtime-child")
	if err := os.Mkdir(child, 0o700); err != nil {
		t.Fatal(err)
	}
	// SYSTEM keeps read-attributes for Lstat/walk; Everyone gets raw
	// READ_ATTRIBUTES|SYNCHRONIZE (no write bits) so the walk can inspect the
	// child while the service SID entry is absent.
	applyDACLDescriptor(t, child, "D:P(A;;FA;;;SY)(A;;0x00100080;;;WD)")
	t.Cleanup(func() { applyDACLDescriptor(t, child, safeProtectedSDDL(sid)) })
	expectStateACLError(t, verifyStateACL(root, name), "service identity ACL entry missing")
}

// 6. reparse descendant (junction; non-elevated equivalent of a symlink) fails
// via the reparse-attribute rejection in the walk.
func TestStateACLReparseDescendantFails(t *testing.T) {
	name, sid := aclFixtureIdentity(t)
	base := t.TempDir()
	root := filepath.Join(base, "state")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	applyDACLDescriptor(t, root, safeProtectedSDDL(sid))
	target := filepath.Join(base, "junction-target")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "runtime-link")
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
		t.Fatalf("mklink /J: %v (%s)", err, out)
	}
	expectStateACLError(t, verifyStateACL(root, name), "path contains a reparse point")
}

// 6b. reparse state root itself fails before any walk.
func TestStateACLReparseRootFails(t *testing.T) {
	name, sid := aclFixtureIdentity(t)
	base := t.TempDir()
	target := filepath.Join(base, "root-target")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	applyDACLDescriptor(t, target, safeProtectedSDDL(sid))
	link := filepath.Join(base, "state-link")
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
		t.Fatalf("mklink /J: %v (%s)", err, out)
	}
	expectStateACLError(t, verifyStateACL(link, name), "path contains a reparse point")
}

// 7. unreadable descendant (denied directory listing) fails closed with the
// walk error branch, not a silent pass.
func TestStateACLWalkErrorFailsClosed(t *testing.T) {
	name, sid := aclFixtureIdentity(t)
	root := protectedStateFixture(t, sid)
	child := filepath.Join(root, "blocked-child")
	if err := os.Mkdir(child, 0o700); err != nil {
		t.Fatal(err)
	}
	// Deny only LIST/READ_DATA (0x1): ACL inspection (READ_CONTROL) and
	// Lstat (READ_ATTRIBUTES) still work, but WalkDir cannot enumerate.
	applyDACLDescriptor(t, child, "D:P(D;;0x00000001;;;"+sid+")(A;;FA;;;SY)(A;;FA;;;"+sid+")")
	expectStateACLError(t, verifyStateACL(root, name), "state ACL walk failed")
}

// 8. missing/non-directory state root and empty service identity still fail
// closed (pre-existing behavior preserved; marker behavior covered by
// state_test.go).
func TestStateACLUnavailableRootFailsClosed(t *testing.T) {
	name, sid := aclFixtureIdentity(t)
	base := t.TempDir()
	root := filepath.Join(base, "state")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	applyDACLDescriptor(t, root, safeProtectedSDDL(sid))

	expectStateACLError(t, verifyStateACL(root, "   "), "service identity missing")
	expectStateACLError(t, verifyStateACL(filepath.Join(base, "missing"), name), "state root unavailable")

	notDir := filepath.Join(base, "not-a-dir")
	if err := os.WriteFile(notDir, nil, 0600); err != nil {
		t.Fatal(err)
	}
	expectStateACLError(t, verifyStateACL(notDir, name), "state root unavailable")
}
