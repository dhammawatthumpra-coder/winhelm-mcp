//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

const stateLockName = "winhelm-go-tls-ingress.lock"

type stateLock struct {
	file       *os.File
	overlapped windows.Overlapped
}

func acquireStateLock(stateDir string) (*stateLock, error) {
	if err := os.MkdirAll(stateDir, 0700); err != nil {
		return nil, err
	}
	path := filepath.Join(stateDir, stateLockName)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, errors.New("state lock unavailable")
	}
	lock := &stateLock{file: f}
	err = windows.LockFileEx(
		windows.Handle(f.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0, 1, 0, &lock.overlapped,
	)
	if err != nil {
		_ = f.Close()
		return nil, errors.New("state lock conflict")
	}
	if _, err := f.Seek(0, 0); err != nil {
		_ = lock.Close()
		return nil, errors.New("state lock metadata unavailable")
	}
	if err := f.Truncate(0); err != nil {
		_ = lock.Close()
		return nil, errors.New("state lock metadata unavailable")
	}
	if _, err := fmt.Fprintf(f, "{\"pid\":%d}\n", os.Getpid()); err != nil {
		_ = lock.Close()
		return nil, errors.New("state lock metadata unavailable")
	}
	if err := f.Sync(); err != nil {
		_ = lock.Close()
		return nil, errors.New("state lock metadata unavailable")
	}
	return lock, nil
}

func (l *stateLock) Close() error {
	if l == nil || l.file == nil {
		return nil
	}
	unlockErr := windows.UnlockFileEx(windows.Handle(l.file.Fd()), 0, 1, 0, &l.overlapped)
	closeErr := l.file.Close()
	l.file = nil
	if unlockErr != nil {
		return unlockErr
	}
	return closeErr
}

func atomicReplaceFile(source, destination string) error {
	src, err := windows.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	dst, err := windows.UTF16PtrFromString(destination)
	if err != nil {
		return err
	}
	if err := windows.MoveFileEx(src, dst, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH); err != nil {
		return fmt.Errorf("atomic marker replace: %w", err)
	}
	return nil
}

func rejectReparsePath(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	abs = filepath.Clean(abs)
	volume := filepath.VolumeName(abs)
	remainder := strings.TrimPrefix(abs, volume)
	current := volume + string(os.PathSeparator)
	for _, part := range strings.Split(strings.Trim(remainder, `\/`), string(os.PathSeparator)) {
		if part == "" {
			continue
		}
		current = filepath.Join(current, part)
		if _, err := os.Lstat(current); err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return errors.New("path validation failed")
		}
		attrs, err := windows.GetFileAttributes(windows.StringToUTF16Ptr(current))
		if err != nil {
			return errors.New("path validation failed")
		}
		if attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return errors.New("path contains a reparse point")
		}
	}
	return nil
}

func sddlHasBroadWritablePrincipal(sddl string) bool {
	for _, raw := range strings.Split(sddl, "(")[1:] {
		fields := strings.Split(strings.TrimSuffix(raw, ")"), ";")
		if len(fields) < 6 {
			continue
		}
		principal := strings.ToUpper(fields[5])
		if principal != "AU" && principal != "BU" && principal != "WD" && principal != "AN" {
			continue
		}
		rights := strings.ToUpper(fields[2])
		if strings.ContainsAny(rights, "WMFG") {
			return true
		}
	}
	return false
}

func verifyACLPath(path, serviceIdentity string, requireProtected bool) error {
	// DACL-only descriptor: the service identity assertion must reflect a real
	// DACL entry, not the owner field (the owner SID also appears in a full
	// SDDL string and would mask a missing service ACE).
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil || sd == nil {
		return errors.New("ACL descriptor unavailable")
	}
	control, _, err := sd.Control()
	if err != nil || (requireProtected && control&windows.SE_DACL_PROTECTED == 0) {
		return errors.New("ACL inheritance is not protected")
	}
	sddl := sd.String()
	if sddl == "" || sddlHasBroadWritablePrincipal(sddl) {
		return errors.New("ACL broad-write floor failed")
	}
	sid, _, _, err := windows.LookupSID("", serviceIdentity)
	if err != nil || sid == nil || sid.String() == "" || !strings.Contains(sddl, sid.String()) {
		return errors.New("service identity ACL entry missing")
	}
	return nil
}

func verifyStateACL(stateDir, serviceIdentity string) error {
	if strings.TrimSpace(serviceIdentity) == "" {
		return errors.New("service identity missing")
	}
	if err := rejectReparsePath(stateDir); err != nil {
		return err
	}
	info, err := os.Stat(stateDir)
	if err != nil || !info.IsDir() {
		return errors.New("state root unavailable")
	}
	// The canonical state root must carry SE_DACL_PROTECTED: it is the
	// protected authority surface whose ACL descendants are allowed to inherit.
	if err := verifyACLPath(stateDir, serviceIdentity, true); err != nil {
		return err
	}
	// Descendants are not required to break inheritance individually. Windows
	// materializes inherited entries into a child's effective DACL, so the
	// broad-write and service-identity checks below still cover inherited and
	// explicit grants alike; only the per-child SE_DACL_PROTECTED flag is
	// intentionally not required for runtime-created children of the protected
	// root.
	return filepath.WalkDir(stateDir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return errors.New("state ACL walk failed")
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("state ACL walk encountered link")
		}
		if path == stateDir {
			return nil
		}
		if err := rejectReparsePath(path); err != nil {
			return err
		}
		return verifyACLPath(path, serviceIdentity, false)
	})
}
