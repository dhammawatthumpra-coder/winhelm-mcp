// Test-only harmless child helper for A4 stdio/environment qualification.
// Never shipped in the production addon surface.

#include <windows.h>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

static bool WriteUtf8File(const std::wstring& path, const std::string& content) {
  HANDLE file = CreateFileW(
      path.c_str(),
      GENERIC_WRITE,
      0,
      nullptr,
      CREATE_ALWAYS,
      FILE_ATTRIBUTE_NORMAL,
      nullptr);
  if (file == INVALID_HANDLE_VALUE) {
    fwprintf(stderr, L"WriteUtf8File open failed err=%lu path=%s\n",
             GetLastError(), path.c_str());
    fflush(stderr);
    return false;
  }
  DWORD written = 0;
  const BOOL ok =
      WriteFile(file, content.data(), static_cast<DWORD>(content.size()), &written, nullptr);
  if (!ok || written != content.size()) {
    fwprintf(stderr, L"WriteUtf8File write failed ok=%d written=%lu err=%lu\n",
             (int)ok, written, GetLastError());
    fflush(stderr);
  }
  CloseHandle(file);
  return ok && written == content.size();
}

static std::string WideToUtf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(
      CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()),
      nullptr, 0, nullptr, nullptr);
  std::string out(size, '\0');
  WideCharToMultiByte(
      CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()),
      out.data(), size, nullptr, nullptr);
  return out;
}

static HANDLE Stdout() {
  return GetStdHandle(STD_OUTPUT_HANDLE);
}

static HANDLE Stderr() {
  return GetStdHandle(STD_ERROR_HANDLE);
}

static bool WriteAll(HANDLE stream, const uint8_t* data, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    DWORD written = 0;
    if (!WriteFile(
            stream,
            data + offset,
            static_cast<DWORD>(length - offset),
            &written,
            nullptr) ||
        written == 0) {
      return false;
    }
    offset += written;
  }
  return true;
}

// Deterministic byte pattern: byte i = (i * 31 + 7) & 0xFF.
static uint8_t PatternByte(uint64_t index) {
  return static_cast<uint8_t>((index * 31ull + 7ull) & 0xFFull);
}

static bool EmitPattern(HANDLE stream, uint64_t bytes, uint64_t& emitted) {
  std::vector<uint8_t> chunk(8192);
  uint64_t done = 0;
  while (done < bytes) {
    const size_t take = static_cast<size_t>(
        (bytes - done) < chunk.size() ? (bytes - done) : chunk.size());
    for (size_t i = 0; i < take; ++i) {
      chunk[i] = PatternByte(emitted + i);
    }
    if (!WriteAll(stream, chunk.data(), take)) return false;
    emitted += take;
    done += take;
  }
  return true;
}

static int CommandEnvReport(const std::wstring& out_path, int argc, wchar_t** argv) {
  std::string report;
  for (int i = 0; i < argc; ++i) {
    const std::wstring name = argv[i];
    const DWORD needed = GetEnvironmentVariableW(name.c_str(), nullptr, 0);
    if (needed == 0 && GetLastError() == ERROR_ENVVAR_NOT_FOUND) {
      report += WideToUtf8(name) + "\t<MISSING>\n";
      continue;
    }
    std::wstring value(needed, L'\0');
    const DWORD actual =
        GetEnvironmentVariableW(name.c_str(), value.data(), needed + 1);
    value.resize(actual);
    report += WideToUtf8(name) + "\t" + WideToUtf8(value) + "\n";
  }
  return WriteUtf8File(out_path, report) ? 0 : 40;
}

static int CommandEnvCount(const std::wstring& out_path) {
  LPWCH block = GetEnvironmentStringsW();
  if (!block) return 41;
  size_t count = 0;
  for (LPWCH cursor = block; *cursor; ) {
    cursor += wcslen(cursor) + 1;
    ++count;
  }
  FreeEnvironmentStringsW(block);
  return WriteUtf8File(out_path, std::to_string(count) + "\n") ? 0 : 42;
}

static int CommandWrite(const std::wstring& mode, uint64_t bytes) {
  uint64_t emitted = 0;
  if (mode == L"stdout") {
    return EmitPattern(Stdout(), bytes, emitted) ? 0 : 50;
  }
  if (mode == L"stderr") {
    return EmitPattern(Stderr(), bytes, emitted) ? 0 : 50;
  }
  if (mode == L"both") {
    // Interleave 8 KiB chunks across stdout and stderr so both pipes carry a
    // large stream concurrently.
    std::vector<uint8_t> chunk(8192);
    uint64_t remaining = bytes;
    bool to_stdout = true;
    while (remaining > 0) {
      const size_t take = static_cast<size_t>(
          remaining < chunk.size() ? remaining : chunk.size());
      for (size_t i = 0; i < take; ++i) {
        chunk[i] = PatternByte(emitted + i);
      }
      if (!WriteAll(to_stdout ? Stdout() : Stderr(), chunk.data(), take)) {
        return 50;
      }
      emitted += take;
      remaining -= take;
      to_stdout = !to_stdout;
    }
    return 0;
  }
  return 51;
}

static int CommandAlloc(uint64_t megabytes) {
  const size_t total = static_cast<size_t>(megabytes) * 1024ull * 1024ull;
  auto* memory = static_cast<uint8_t*>(malloc(total ? total : 1));
  if (!memory) return 60;
  memset(memory, 0xAB, total ? total : 1);
  Sleep(300);
  free(memory);
  return 0;
}

static int CommandStdinReport(const std::wstring& out_path) {
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  uint64_t total = 0;
  uint8_t buffer[4096];
  for (;;) {
    DWORD bytes_read = 0;
    if (!ReadFile(input, buffer, sizeof(buffer), &bytes_read, nullptr)) {
      break;
    }
    if (bytes_read == 0) break;
    total += bytes_read;
  }
  return WriteUtf8File(out_path, std::to_string(total) + "\n") ? 0 : 44;
}

static int CommandProbeExclusive(const std::wstring& target, const std::wstring& out_path) {
  const DWORD deadline = GetTickCount() + 10000;
  for (;;) {
    HANDLE file = CreateFileW(
        target.c_str(),
        GENERIC_READ,
        0,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        nullptr);
    if (file != INVALID_HANDLE_VALUE) {
      CloseHandle(file);
      return WriteUtf8File(out_path, "OPENED\n") ? 0 : 45;
    }
    const DWORD error = GetLastError();
    if (error != ERROR_SHARING_VIOLATION && error != ERROR_LOCK_VIOLATION) {
      WriteUtf8File(out_path, "ERROR " + std::to_string(error) + "\n");
      return 45;
    }
    if (GetTickCount() >= deadline) {
      WriteUtf8File(out_path, "BLOCKED\n");
      return 43;
    }
    Sleep(50);
  }
}

int wmain(int argc, wchar_t** argv) {
  if (argc < 2) return 39;
  const std::wstring command = argv[1];

  if (command == L"env-report" && argc >= 3) {
    return CommandEnvReport(argv[2], argc - 3, argv + 3);
  }
  if (command == L"env-count" && argc == 3) {
    return CommandEnvCount(argv[2]);
  }
  if (command == L"write" && argc >= 4) {
    const uint64_t bytes = wcstoull(argv[3], nullptr, 10);
    return CommandWrite(argv[2], bytes);
  }
  if (command == L"alloc" && argc == 3) {
    return CommandAlloc(wcstoull(argv[2], nullptr, 10));
  }
  if (command == L"stdin-report" && argc == 3) {
    return CommandStdinReport(argv[2]);
  }
  if (command == L"probe-exclusive" && argc == 4) {
    return CommandProbeExclusive(argv[2], argv[3]);
  }
  if (command == L"exit" && argc == 3) {
    return static_cast<int>(wcstoul(argv[2], nullptr, 10) & 0xFF);
  }
  return 39;
}
