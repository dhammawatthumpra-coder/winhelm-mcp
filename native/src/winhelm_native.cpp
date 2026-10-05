#include <windows.h>
#include <bcrypt.h>
#include <psapi.h>
#include <node_api.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <cwchar>
#include <iomanip>
#include <limits>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#pragma comment(lib, "bcrypt.lib")

namespace {

constexpr size_t kMaxStringChars = 32768;
constexpr size_t kMaxBufferBytes = 128ull * 1024ull * 1024ull;
constexpr size_t kMaxEnvEntries = 1024;
constexpr size_t kMaxEnvBlockChars = 32767;
constexpr size_t kMaxCaptureBytes = kMaxBufferBytes;
constexpr size_t kCollectorChunkBytes = 64 * 1024;
std::atomic<unsigned long long> g_temp_counter{0};

// Output stream index convention shared by collectors and JS-facing methods.
constexpr int kStreamStdout = 0;
constexpr int kStreamStderr = 1;

// Local NTSTATUS stand-ins used only as stable native error codes; ntstatus.h
// is intentionally not included.
constexpr NTSTATUS kNapiStatusInvalidParameter = static_cast<NTSTATUS>(0xC000000Dul);
constexpr NTSTATUS kNapiStatusUnsuccessful = static_cast<NTSTATUS>(0xC0000001ul);

struct StableReadState {
  HANDLE handle = INVALID_HANDLE_VALUE;
  bool closed = false;
};

enum class SinkMode {
  CreateNew,
  Overwrite,
  Append,
};

struct StreamState {
  HANDLE read_end = nullptr;
  HANDLE sink = nullptr;
  uint32_t capture_limit = 0;

  std::mutex mutex;
  std::string capture;
  uint64_t total = 0;
  bool truncated = false;
  bool done = false;
  bool has_error = false;
  uint32_t error_code = 0;

  BCRYPT_ALG_HANDLE alg = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  std::vector<uint8_t> hash_object;
  uint8_t digest[32] = {};
  bool digest_ready = false;

#ifdef WINHELM_NATIVE_TEST_HOOKS
  uint64_t test_sink_fail_after_bytes = 0;
  uint64_t sink_bytes_written = 0;
  bool test_sink_failed = false;
#endif
};

void DestroyStreamHash(StreamState& stream) {
  if (stream.hash) {
    BCryptDestroyHash(stream.hash);
    stream.hash = nullptr;
  }
  if (stream.alg) {
    BCryptCloseAlgorithmProvider(stream.alg, 0);
    stream.alg = nullptr;
  }
  stream.hash_object.clear();
  stream.hash_object.shrink_to_fit();
}

bool CreateStreamHash(StreamState& stream) {
  DWORD object_length = 0;
  DWORD result_length = 0;
  NTSTATUS status = BCryptOpenAlgorithmProvider(
      &stream.alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0);
  if (status < 0) return false;
  status = BCryptGetProperty(
      stream.alg,
      BCRYPT_OBJECT_LENGTH,
      reinterpret_cast<PUCHAR>(&object_length),
      sizeof(object_length),
      &result_length,
      0);
  if (status < 0) {
    DestroyStreamHash(stream);
    return false;
  }
  stream.hash_object.assign(object_length, 0);
  status = BCryptCreateHash(
      stream.alg,
      &stream.hash,
      stream.hash_object.data(),
      static_cast<ULONG>(stream.hash_object.size()),
      nullptr,
      0,
      0);
  if (status < 0) {
    DestroyStreamHash(stream);
    return false;
  }
  return true;
}

struct ProcessState {
  HANDLE process = nullptr;
  HANDLE thread = nullptr;
  HANDLE job = nullptr;
  DWORD pid = 0;
  bool closed = false;

  bool a4 = false;
  StreamState streams[2];
  std::thread collectors[2];
  bool collectors_started = false;
  bool collectors_joined = false;

  std::mutex wait_mutex;
  bool wait_pending = false;
  napi_async_work wait_work = nullptr;
  napi_deferred wait_deferred = nullptr;
  napi_ref wait_keepalive = nullptr;
  uint32_t async_timeout_ms = 0;
  bool async_wait_failed = false;
  uint32_t async_wait_error = 0;
  bool async_exited = false;
  uint32_t async_exit_code = 0;

#ifdef WINHELM_NATIVE_TEST_HOOKS
  std::vector<std::string> steps;
  uint32_t wait_for_single_object_calls = 0;
  uint32_t terminate_job_object_calls = 0;
#endif
};

void JoinCollectors(ProcessState* state) {
  if (!state || !state->collectors_started || state->collectors_joined) return;
  for (auto& worker : state->collectors) {
    if (worker.joinable()) worker.join();
  }
  state->collectors_joined = true;
  // Deterministic sink closure: once the collectors have finished mirroring,
  // the server-owned sink handles are released and the final stream state is
  // safe to journal/return.
  for (int index = 0; index < 2; ++index) {
    StreamState& stream = state->streams[index];
    if (stream.sink) {
      CloseHandle(stream.sink);
      stream.sink = nullptr;
    }
  }
}

void CloseStreamHandles(ProcessState* state) {
  for (int index = 0; index < 2; ++index) {
    StreamState& stream = state->streams[index];
    if (stream.read_end) {
      CloseHandle(stream.read_end);
      stream.read_end = nullptr;
    }
    if (stream.sink) {
      CloseHandle(stream.sink);
      stream.sink = nullptr;
    }
    DestroyStreamHash(stream);
  }
}

void CloseProcessState(ProcessState* state) {
  if (!state || state->closed) return;
  if (state->a4) {
    if (state->process) {
      if (WaitForSingleObject(state->process, 0) != WAIT_OBJECT_0) {
        if (state->job) {
          TerminateJobObject(state->job, ERROR_PROCESS_ABORTED);
        } else {
          TerminateProcess(state->process, ERROR_PROCESS_ABORTED);
        }
      }
      WaitForSingleObject(state->process, 5000);
    }
    JoinCollectors(state);
    CloseStreamHandles(state);
  }
  if (state->job) {
    CloseHandle(state->job);
    state->job = nullptr;
  }
  if (state->thread) {
    CloseHandle(state->thread);
    state->thread = nullptr;
  }
  if (state->process) {
    CloseHandle(state->process);
    state->process = nullptr;
  }
  state->closed = true;
}

void CloseStable(StableReadState* state) {
  if (!state || state->closed) return;
  if (state->handle != INVALID_HANDLE_VALUE) {
    CloseHandle(state->handle);
    state->handle = INVALID_HANDLE_VALUE;
  }
  state->closed = true;
}

void StableFinalize(napi_env, void* data, void*) {
  auto* state = static_cast<StableReadState*>(data);
  CloseStable(state);
  delete state;
}

void ProcessFinalize(napi_env, void* data, void*) {
  auto* state = static_cast<ProcessState*>(data);
  CloseProcessState(state);
  delete state;
}

napi_value MakeString(napi_env env, const std::string& value) {
  napi_value out;
  napi_create_string_utf8(env, value.c_str(), value.size(), &out);
  return out;
}

napi_value MakeUtf16String(napi_env env, const std::wstring& value) {
  napi_value out;
  napi_create_string_utf16(
      env,
      reinterpret_cast<const char16_t*>(value.data()),
      value.size(),
      &out);
  return out;
}

napi_value MakeUint32(napi_env env, uint32_t value) {
  napi_value out;
  napi_create_uint32(env, value, &out);
  return out;
}

napi_value MakeDouble(napi_env env, double value) {
  napi_value out;
  napi_create_double(env, value, &out);
  return out;
}

napi_value MakeBool(napi_env env, bool value) {
  napi_value out;
  napi_get_boolean(env, value, &out);
  return out;
}

void SetProp(napi_env env, napi_value obj, const char* name, napi_value value) {
  napi_set_named_property(env, obj, name, value);
}

napi_value ThrowStructured(
    napi_env env,
    const char* stable_code,
    uint32_t native_code,
    const std::string& message) {
  napi_value msg = MakeString(env, message);
  napi_value err;
  napi_create_error(env, nullptr, msg, &err);
  SetProp(env, err, "code", MakeString(env, stable_code));
  SetProp(env, err, "nativeCode", MakeUint32(env, native_code));
  napi_throw(env, err);
  return nullptr;
}

napi_value ThrowWin32(
    napi_env env,
    const char* stable_code,
    DWORD native_code,
    const char* operation) {
  std::ostringstream oss;
  oss << operation << " failed with Win32 error " << native_code;
  return ThrowStructured(env, stable_code, native_code, oss.str());
}

bool GetWideString(
    napi_env env,
    napi_value value,
    std::wstring& out,
    const char* field_name,
    bool allow_empty = false) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) {
    ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                    std::string(field_name) + " must be a string");
    return false;
  }

  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok) {
    ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                    std::string("Unable to read ") + field_name);
    return false;
  }
  if (length > kMaxStringChars) {
    ThrowStructured(env, "INPUT_TOO_LARGE", ERROR_BUFFER_OVERFLOW,
                    std::string(field_name) + " exceeds maximum length");
    return false;
  }

  std::vector<char16_t> buffer(length + 1);
  size_t copied = 0;
  if (napi_get_value_string_utf16(
          env, value, buffer.data(), buffer.size(), &copied) != napi_ok) {
    ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                    std::string("Unable to decode ") + field_name);
    return false;
  }

  out.assign(reinterpret_cast<const wchar_t*>(buffer.data()), copied);
  if (!allow_empty && out.empty()) {
    ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                    std::string(field_name) + " must not be empty");
    return false;
  }
  if (out.find(L'\0') != std::wstring::npos) {
    ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                    std::string(field_name) + " contains an embedded NUL");
    return false;
  }
  return true;
}

bool GetBuffer(
    napi_env env,
    napi_value value,
    const uint8_t*& data,
    size_t& length,
    const char* field_name) {
  bool is_buffer = false;
  if (napi_is_buffer(env, value, &is_buffer) != napi_ok || !is_buffer) {
    ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                    std::string(field_name) + " must be a Buffer");
    return false;
  }
  void* raw = nullptr;
  if (napi_get_buffer_info(env, value, &raw, &length) != napi_ok) {
    ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                    std::string("Unable to read ") + field_name);
    return false;
  }
  if (length > kMaxBufferBytes) {
    ThrowStructured(env, "INPUT_TOO_LARGE", ERROR_BUFFER_OVERFLOW,
                    std::string(field_name) + " exceeds 128 MiB");
    return false;
  }
  data = static_cast<const uint8_t*>(raw);
  return true;
}

bool GetUint32(
    napi_env env,
    napi_value value,
    uint32_t& out,
    const char* field_name) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number) {
    ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                    std::string(field_name) + " must be a number");
    return false;
  }

  double numeric_value = 0.0;
  if (napi_get_value_double(env, value, &numeric_value) != napi_ok) {
    ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                    std::string("Unable to read ") + field_name);
    return false;
  }

  constexpr double kUint32Max =
      static_cast<double>(std::numeric_limits<uint32_t>::max());
  if (!std::isfinite(numeric_value) ||
      std::trunc(numeric_value) != numeric_value ||
      numeric_value < 0.0 || numeric_value > kUint32Max) {
    ThrowStructured(
        env,
        "INVALID_ARGUMENT",
        ERROR_INVALID_PARAMETER,
        std::string(field_name) + " must be an integer in the uint32 range");
    return false;
  }

  out = static_cast<uint32_t>(numeric_value);
  return true;
}

std::string Hex(const uint8_t* data, size_t length) {
  static const char* kHex = "0123456789abcdef";
  std::string out;
  out.resize(length * 2);
  for (size_t i = 0; i < length; ++i) {
    out[i * 2] = kHex[(data[i] >> 4) & 0x0f];
    out[i * 2 + 1] = kHex[data[i] & 0x0f];
  }
  return out;
}

bool HashHandleSha256(
    HANDLE file,
    std::string& sha256,
    uint64_t& total_bytes,
    uint32_t& native_error) {
  native_error = ERROR_SUCCESS;
  total_bytes = 0;

  LARGE_INTEGER zero{};
  if (!SetFilePointerEx(file, zero, nullptr, FILE_BEGIN)) {
    native_error = GetLastError();
    return false;
  }

  BCRYPT_ALG_HANDLE alg = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD object_length = 0;
  DWORD result_length = 0;
  NTSTATUS status = BCryptOpenAlgorithmProvider(
      &alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0);
  if (status < 0) {
    native_error = static_cast<uint32_t>(status);
    return false;
  }

  status = BCryptGetProperty(
      alg,
      BCRYPT_OBJECT_LENGTH,
      reinterpret_cast<PUCHAR>(&object_length),
      sizeof(object_length),
      &result_length,
      0);
  if (status < 0) {
    native_error = static_cast<uint32_t>(status);
    BCryptCloseAlgorithmProvider(alg, 0);
    return false;
  }

  std::vector<uint8_t> hash_object(object_length);
  status = BCryptCreateHash(
      alg,
      &hash,
      hash_object.data(),
      static_cast<ULONG>(hash_object.size()),
      nullptr,
      0,
      0);
  if (status < 0) {
    native_error = static_cast<uint32_t>(status);
    BCryptCloseAlgorithmProvider(alg, 0);
    return false;
  }

  std::vector<uint8_t> buffer(64 * 1024);
  for (;;) {
    DWORD bytes_read = 0;
    if (!ReadFile(
            file,
            buffer.data(),
            static_cast<DWORD>(buffer.size()),
            &bytes_read,
            nullptr)) {
      native_error = GetLastError();
      BCryptDestroyHash(hash);
      BCryptCloseAlgorithmProvider(alg, 0);
      return false;
    }
    if (bytes_read == 0) break;

    status = BCryptHashData(hash, buffer.data(), bytes_read, 0);
    if (status < 0) {
      native_error = static_cast<uint32_t>(status);
      BCryptDestroyHash(hash);
      BCryptCloseAlgorithmProvider(alg, 0);
      return false;
    }
    total_bytes += bytes_read;
  }

  uint8_t digest[32];
  status = BCryptFinishHash(hash, digest, sizeof(digest), 0);
  if (status < 0) {
    native_error = static_cast<uint32_t>(status);
    BCryptDestroyHash(hash);
    BCryptCloseAlgorithmProvider(alg, 0);
    return false;
  }

  BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(alg, 0);
  sha256 = Hex(digest, sizeof(digest));

  if (!SetFilePointerEx(file, zero, nullptr, FILE_BEGIN)) {
    native_error = GetLastError();
    return false;
  }
  return true;
}

bool WriteAll(
    HANDLE file,
    const uint8_t* data,
    size_t length,
    DWORD& native_error) {
  native_error = ERROR_SUCCESS;
  size_t offset = 0;
  while (offset < length) {
    const size_t remaining = length - offset;
    const DWORD chunk = static_cast<DWORD>(
        std::min<size_t>(remaining, std::numeric_limits<DWORD>::max()));
    DWORD written = 0;
    if (!WriteFile(file, data + offset, chunk, &written, nullptr)) {
      native_error = GetLastError();
      return false;
    }
    if (written == 0) {
      native_error = ERROR_WRITE_FAULT;
      return false;
    }
    offset += written;
  }
  return true;
}

std::wstring ParentDirectory(const std::wstring& path) {
  const size_t pos = path.find_last_of(L"\\/");
  if (pos == std::wstring::npos) return L".";
  if (pos == 2 && path.size() >= 3 && path[1] == L':') return path.substr(0, 3);
  if (pos == 0) return path.substr(0, 1);
  return path.substr(0, pos);
}

std::wstring FileNamePart(const std::wstring& path) {
  const size_t pos = path.find_last_of(L"\\/");
  return pos == std::wstring::npos ? path : path.substr(pos + 1);
}

bool CreateUniqueTempInSameDirectory(
    const std::wstring& target,
    HANDLE& out_handle,
    std::wstring& out_path,
    DWORD& native_error) {
  const std::wstring parent = ParentDirectory(target);
  const std::wstring file_name = FileNamePart(target);
  const DWORD pid = GetCurrentProcessId();

  for (int attempt = 0; attempt < 128; ++attempt) {
    const unsigned long long serial = ++g_temp_counter;
    std::wostringstream name;
    name << parent;
    if (!parent.empty() && parent.back() != L'\\' && parent.back() != L'/') {
      name << L'\\';
    }
    name << L'.' << file_name << L".winhelm.tmp." << pid << L'.'
         << GetTickCount64() << L'.' << serial;
    out_path = name.str();

    HANDLE file = CreateFileW(
        out_path.c_str(),
        GENERIC_WRITE,
        0,
        nullptr,
        CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL,
        nullptr);
    if (file != INVALID_HANDLE_VALUE) {
      out_handle = file;
      native_error = ERROR_SUCCESS;
      return true;
    }

    native_error = GetLastError();
    if (native_error != ERROR_FILE_EXISTS &&
        native_error != ERROR_ALREADY_EXISTS) {
      return false;
    }
  }

  native_error = ERROR_ALREADY_EXISTS;
  return false;
}

std::wstring QuoteWindowsArg(const std::wstring& arg) {
  if (arg.empty()) return L"\"\"";
  const bool needs_quotes =
      arg.find_first_of(L" \t\n\v\"") != std::wstring::npos;
  if (!needs_quotes) return arg;

  std::wstring out;
  out.push_back(L'"');
  size_t backslashes = 0;
  for (wchar_t ch : arg) {
    if (ch == L'\\') {
      ++backslashes;
      continue;
    }
    if (ch == L'"') {
      out.append(backslashes * 2 + 1, L'\\');
      out.push_back(L'"');
      backslashes = 0;
      continue;
    }
    out.append(backslashes, L'\\');
    backslashes = 0;
    out.push_back(ch);
  }
  out.append(backslashes * 2, L'\\');
  out.push_back(L'"');
  return out;
}

bool GetStringArray(
    napi_env env,
    napi_value value,
    std::vector<std::wstring>& out,
    const char* field_name) {
  bool is_array = false;
  if (napi_is_array(env, value, &is_array) != napi_ok || !is_array) {
    ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                    std::string(field_name) + " must be an array");
    return false;
  }
  uint32_t length = 0;
  napi_get_array_length(env, value, &length);
  if (length > 1024) {
    ThrowStructured(env, "INPUT_TOO_LARGE", ERROR_BUFFER_OVERFLOW,
                    std::string(field_name) + " has too many entries");
    return false;
  }
  out.clear();
  out.reserve(length);
  for (uint32_t i = 0; i < length; ++i) {
    napi_value item;
    napi_get_element(env, value, i, &item);
    std::wstring text;
    if (!GetWideString(env, item, text, field_name, true)) return false;
    out.push_back(std::move(text));
  }
  return true;
}

std::wstring BuildCommandLine(
    const std::wstring& command,
    const std::vector<std::wstring>& args) {
  std::wstring out = QuoteWindowsArg(command);
  for (const auto& arg : args) {
    out.push_back(L' ');
    out += QuoteWindowsArg(arg);
  }
  return out;
}

struct EnvEntry {
  std::wstring name;
  std::wstring value;
};

// Windows ordinal case-insensitive identity: CompareStringOrdinal(..., TRUE)
// folds through the OS upcase table, matching the semantics Windows itself
// uses for environment-variable lookup. Returns CSTR_LESS_THAN / CSTR_EQUAL /
// CSTR_GREATER_THAN; sets ok=false when the Win32 comparison call itself
// fails so callers can fail closed instead of treating the pair as unequal.
int EnvNameWindowsCompare(const std::wstring& a, const std::wstring& b, bool& ok) {
  const int result = CompareStringOrdinal(
      a.c_str(), static_cast<int>(a.size()),
      b.c_str(), static_cast<int>(b.size()), TRUE);
  if (result != CSTR_LESS_THAN && result != CSTR_EQUAL &&
      result != CSTR_GREATER_THAN) {
    ok = false;
    return CSTR_EQUAL;
  }
  return result;
}

bool BuildEnvironmentBlock(
    const std::vector<EnvEntry>& entries,
    std::vector<wchar_t>& block) {
  // The block is a sequence of name=value strings each NUL-terminated, closed
  // by an empty string (double NUL). An explicitly empty environment is
  // therefore two NULs.
  size_t total_chars = entries.empty() ? 2 : 1;
  for (const auto& entry : entries) {
    total_chars += entry.name.size() + 1 + entry.value.size() + 1;
  }
  if (total_chars > kMaxEnvBlockChars) return false;

  block.clear();
  block.reserve(total_chars);
  for (const auto& entry : entries) {
    block.insert(block.end(), entry.name.begin(), entry.name.end());
    block.push_back(L'=');
    block.insert(block.end(), entry.value.begin(), entry.value.end());
    block.push_back(L'\0');
  }
  block.push_back(L'\0');
  if (block.size() < 2) {
    block.push_back(L'\0');
  }
  return true;
}

bool OpenSinkHandle(
    const std::wstring& path,
    SinkMode mode,
    HANDLE& out_handle,
    DWORD& native_error) {
  const DWORD creation = mode == SinkMode::CreateNew ? CREATE_NEW
                       : mode == SinkMode::Overwrite ? CREATE_ALWAYS
                                                     : OPEN_ALWAYS;
  HANDLE file = CreateFileW(
      path.c_str(),
      GENERIC_WRITE,
      0,
      nullptr,
      creation,
      FILE_ATTRIBUTE_NORMAL,
      nullptr);
  if (file == INVALID_HANDLE_VALUE) {
    native_error = GetLastError();
    return false;
  }
  if (mode == SinkMode::Append) {
    LARGE_INTEGER zero{};
    if (!SetFilePointerEx(file, zero, nullptr, FILE_END)) {
      native_error = GetLastError();
      CloseHandle(file);
      return false;
    }
  }
  out_handle = file;
  native_error = ERROR_SUCCESS;
  return true;
}

// Continuous native drain loop: every drained byte is hashed exactly once and
// counted, only the bounded prefix is retained, and an optional physical sink
// receives a mirror of the full stream. Any governed fatal error fails closed
// by terminating the contained Job tree instead of silently losing evidence.
void CollectorMain(ProcessState* state, int index) {
  StreamState& stream = state->streams[index];
  std::vector<uint8_t> buffer(kCollectorChunkBytes);
  bool fatal_error = false;

  for (;;) {
    DWORD bytes_read = 0;
    if (!ReadFile(
            stream.read_end,
            buffer.data(),
            static_cast<DWORD>(buffer.size()),
            &bytes_read,
            nullptr)) {
      const DWORD error = GetLastError();
      std::lock_guard<std::mutex> lock(stream.mutex);
      if (error != ERROR_BROKEN_PIPE && error != ERROR_NO_DATA) {
        stream.has_error = true;
        stream.error_code = error;
        fatal_error = true;
      }
      break;
    }
    if (bytes_read == 0) break;

    const NTSTATUS hash_status = stream.hash
        ? BCryptHashData(stream.hash, buffer.data(), bytes_read, 0)
        : kNapiStatusInvalidParameter;

    {
      std::lock_guard<std::mutex> lock(stream.mutex);
      stream.total += bytes_read;
      if (stream.capture.size() < stream.capture_limit) {
        const size_t take = std::min<size_t>(
            bytes_read, stream.capture_limit - stream.capture.size());
        stream.capture.append(
            reinterpret_cast<const char*>(buffer.data()), take);
      }
      if (stream.total > stream.capture.size()) {
        stream.truncated = true;
      }
      if (hash_status < 0) {
        stream.has_error = true;
        stream.error_code = static_cast<uint32_t>(hash_status);
        fatal_error = true;
      }
    }
    if (fatal_error) break;

    if (stream.sink) {
      const uint8_t* data = buffer.data();
      size_t remaining = bytes_read;
      while (remaining > 0) {
        size_t chunk = remaining;
#ifdef WINHELM_NATIVE_TEST_HOOKS
        if (stream.test_sink_fail_after_bytes > 0 && !stream.test_sink_failed) {
          const uint64_t allowed =
              stream.test_sink_fail_after_bytes > stream.sink_bytes_written
                  ? stream.test_sink_fail_after_bytes -
                        stream.sink_bytes_written
                  : 0;
          if (allowed == 0) {
            std::lock_guard<std::mutex> lock(stream.mutex);
            stream.has_error = true;
            stream.error_code = ERROR_WRITE_FAULT;
            stream.test_sink_failed = true;
            fatal_error = true;
            break;
          }
          chunk = std::min<size_t>(chunk, static_cast<size_t>(allowed));
        }
#endif
        DWORD written = 0;
        if (!WriteFile(
                stream.sink,
                data,
                static_cast<DWORD>(chunk),
                &written,
                nullptr) ||
            written == 0) {
          std::lock_guard<std::mutex> lock(stream.mutex);
          stream.has_error = true;
          stream.error_code = written == 0 ? ERROR_WRITE_FAULT
                                           : GetLastError();
          fatal_error = true;
          break;
        }
#ifdef WINHELM_NATIVE_TEST_HOOKS
        stream.sink_bytes_written += written;
#endif
        data += written;
        remaining -= written;
      }
      if (fatal_error) break;
    }
  }

  if (fatal_error && state->job) {
    TerminateJobObject(state->job, ERROR_PROCESS_ABORTED);
  }

  {
    std::lock_guard<std::mutex> lock(stream.mutex);
    if (!stream.has_error && stream.hash && !stream.digest_ready) {
      if (BCryptFinishHash(
              stream.hash, stream.digest, sizeof(stream.digest), 0) >= 0) {
        stream.digest_ready = true;
      } else {
        stream.has_error = true;
        stream.error_code = static_cast<uint32_t>(kNapiStatusUnsuccessful);
      }
    }
    stream.done = true;
  }
}

bool IsAbsoluteWindowsPath(const std::wstring& path) {
  if (path.size() >= 3 &&
      ((path[0] >= L'A' && path[0] <= L'Z') ||
       (path[0] >= L'a' && path[0] <= L'z')) &&
      path[1] == L':' &&
      (path[2] == L'\\' || path[2] == L'/')) {
    return true;
  }
  return path.size() >= 2 &&
         ((path[0] == L'\\' && path[1] == L'\\') ||
          (path[0] == L'/' && path[1] == L'/'));
}

bool GetThisAndArgs(
    napi_env env,
    napi_callback_info info,
    size_t max_args,
    size_t& argc,
    napi_value* argv,
    napi_value& this_value) {
  argc = max_args;
  return napi_get_cb_info(env, info, &argc, argv, &this_value, nullptr) ==
         napi_ok;
}

StableReadState* UnwrapStable(
    napi_env env,
    napi_callback_info info,
    napi_value& this_value) {
  napi_value argv[1];
  size_t argc = 0;
  if (!GetThisAndArgs(env, info, 0, argc, argv, this_value)) return nullptr;
  StableReadState* state = nullptr;
  if (napi_unwrap(env, this_value, reinterpret_cast<void**>(&state)) != napi_ok ||
      !state) {
    ThrowStructured(env, "INVALID_NATIVE_STATE", ERROR_INVALID_HANDLE,
                    "Stable-read state is unavailable");
    return nullptr;
  }
  if (state->closed || state->handle == INVALID_HANDLE_VALUE) {
    ThrowStructured(env, "HANDLE_CLOSED", ERROR_INVALID_HANDLE,
                    "Stable-read handle is already closed");
    return nullptr;
  }
  return state;
}

ProcessState* UnwrapProcess(
    napi_env env,
    napi_callback_info info,
    size_t max_args,
    size_t& argc,
    napi_value* argv,
    napi_value& this_value,
    bool allow_closed = false) {
  if (!GetThisAndArgs(env, info, max_args, argc, argv, this_value)) return nullptr;
  ProcessState* state = nullptr;
  if (napi_unwrap(env, this_value, reinterpret_cast<void**>(&state)) != napi_ok ||
      !state) {
    ThrowStructured(env, "INVALID_NATIVE_STATE", ERROR_INVALID_HANDLE,
                    "Process state is unavailable");
    return nullptr;
  }
  if (!allow_closed && state->closed) {
    ThrowStructured(env, "HANDLE_CLOSED", ERROR_INVALID_HANDLE,
                    "Contained-process state is already closed");
    return nullptr;
  }
  return state;
}

napi_value StableMetadata(napi_env env, napi_callback_info info) {
  napi_value this_value;
  StableReadState* state = UnwrapStable(env, info, this_value);
  if (!state) return nullptr;

  FILE_ATTRIBUTE_TAG_INFO attr{};
  if (!GetFileInformationByHandleEx(
          state->handle,
          FileAttributeTagInfo,
          &attr,
          sizeof(attr))) {
    const DWORD error = GetLastError();
    return ThrowWin32(env, "FILE_METADATA_FAILED", error,
                      "GetFileInformationByHandleEx");
  }

  BY_HANDLE_FILE_INFORMATION info_by_handle{};
  if (!GetFileInformationByHandle(state->handle, &info_by_handle)) {
    const DWORD error = GetLastError();
    return ThrowWin32(env, "FILE_METADATA_FAILED", error,
                      "GetFileInformationByHandle");
  }

  napi_value out;
  napi_create_object(env, &out);
  SetProp(env, out, "fileAttributes", MakeUint32(env, attr.FileAttributes));
  SetProp(env, out, "reparseTag", MakeUint32(env, attr.ReparseTag));
  SetProp(env, out, "reparsePoint",
          MakeBool(env, (attr.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0));
  SetProp(env, out, "volumeSerialNumber",
          MakeUint32(env, info_by_handle.dwVolumeSerialNumber));
  SetProp(env, out, "fileIndexHigh", MakeUint32(env, info_by_handle.nFileIndexHigh));
  SetProp(env, out, "fileIndexLow", MakeUint32(env, info_by_handle.nFileIndexLow));
  return out;
}

napi_value StableSnapshot(napi_env env, napi_callback_info info) {
  napi_value this_value;
  StableReadState* state = UnwrapStable(env, info, this_value);
  if (!state) return nullptr;

  std::string sha256;
  uint64_t total_bytes = 0;
  uint32_t native_error = 0;
  if (!HashHandleSha256(
          state->handle, sha256, total_bytes, native_error)) {
    return ThrowStructured(
        env,
        "STABLE_READ_FAILED",
        native_error,
        "Failed to read/hash retained stable-read handle");
  }

  FILE_ATTRIBUTE_TAG_INFO attr{};
  if (!GetFileInformationByHandleEx(
          state->handle,
          FileAttributeTagInfo,
          &attr,
          sizeof(attr))) {
    const DWORD error = GetLastError();
    return ThrowWin32(env, "FILE_METADATA_FAILED", error,
                      "GetFileInformationByHandleEx");
  }

  BY_HANDLE_FILE_INFORMATION info_by_handle{};
  if (!GetFileInformationByHandle(state->handle, &info_by_handle)) {
    const DWORD error = GetLastError();
    return ThrowWin32(env, "FILE_METADATA_FAILED", error,
                      "GetFileInformationByHandle");
  }

  napi_value out;
  napi_create_object(env, &out);
  SetProp(env, out, "bytes", MakeDouble(env, static_cast<double>(total_bytes)));
  SetProp(env, out, "sha256", MakeString(env, sha256));
  SetProp(env, out, "fileAttributes", MakeUint32(env, attr.FileAttributes));
  SetProp(env, out, "reparseTag", MakeUint32(env, attr.ReparseTag));
  SetProp(env, out, "reparsePoint",
          MakeBool(env, (attr.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0));
  SetProp(env, out, "volumeSerialNumber",
          MakeUint32(env, info_by_handle.dwVolumeSerialNumber));
  SetProp(env, out, "fileIndexHigh", MakeUint32(env, info_by_handle.nFileIndexHigh));
  SetProp(env, out, "fileIndexLow", MakeUint32(env, info_by_handle.nFileIndexLow));
  return out;
}

napi_value StableClose(napi_env env, napi_callback_info info) {
  napi_value this_value;
  napi_value argv[1];
  size_t argc = 0;
  if (!GetThisAndArgs(env, info, 0, argc, argv, this_value)) return nullptr;
  StableReadState* state = nullptr;
  if (napi_unwrap(env, this_value, reinterpret_cast<void**>(&state)) != napi_ok ||
      !state) {
    return ThrowStructured(env, "INVALID_NATIVE_STATE", ERROR_INVALID_HANDLE,
                           "Stable-read state is unavailable");
  }
  CloseStable(state);
  napi_value undefined_value;
  napi_get_undefined(env, &undefined_value);
  return undefined_value;
}

napi_value StableReadOpen(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 1;
  napi_value this_value;
  if (!GetThisAndArgs(env, info, 1, argc, argv, this_value) || argc != 1) {
    return ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                           "stableReadOpen(path) requires exactly one argument");
  }

  std::wstring path;
  if (!GetWideString(env, argv[0], path, "path")) return nullptr;

  HANDLE file = CreateFileW(
      path.c_str(),
      GENERIC_READ,
      FILE_SHARE_READ,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN |
          FILE_FLAG_BACKUP_SEMANTICS,
      nullptr);
  if (file == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    return ThrowWin32(env, "STABLE_READ_UNAVAILABLE", error, "CreateFileW");
  }

  auto* state = new StableReadState();
  state->handle = file;

  napi_value object;
  napi_create_object(env, &object);
  if (napi_wrap(env, object, state, StableFinalize, nullptr, nullptr) != napi_ok) {
    CloseStable(state);
    delete state;
    return ThrowStructured(env, "NATIVE_WRAP_FAILED", ERROR_INVALID_DATA,
                           "Unable to wrap stable-read state");
  }

  napi_property_descriptor props[] = {
      {"snapshot", nullptr, StableSnapshot, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"metadata", nullptr, StableMetadata, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, StableClose, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, object, 3, props);
  return object;
}

napi_value CreateExclusive(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  size_t argc = 2;
  napi_value this_value;
  if (!GetThisAndArgs(env, info, 2, argc, argv, this_value) || argc != 2) {
    return ThrowStructured(
        env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
        "createExclusive(path, buffer) requires exactly two arguments");
  }

  std::wstring path;
  if (!GetWideString(env, argv[0], path, "path")) return nullptr;
  const uint8_t* data = nullptr;
  size_t length = 0;
  if (!GetBuffer(env, argv[1], data, length, "buffer")) return nullptr;

  HANDLE file = CreateFileW(
      path.c_str(),
      GENERIC_WRITE,
      0,
      nullptr,
      CREATE_NEW,
      FILE_ATTRIBUTE_NORMAL,
      nullptr);
  if (file == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    const char* code =
        (error == ERROR_FILE_EXISTS || error == ERROR_ALREADY_EXISTS)
            ? "FILE_ALREADY_EXISTS"
            : "CREATE_EXCLUSIVE_FAILED";
    return ThrowWin32(env, code, error, "CreateFileW(CREATE_NEW)");
  }

  DWORD native_error = ERROR_SUCCESS;
  if (!WriteAll(file, data, length, native_error)) {
    CloseHandle(file);
    DeleteFileW(path.c_str());
    return ThrowWin32(env, "NATIVE_WRITE_FAILED", native_error, "WriteFile");
  }

  if (!FlushFileBuffers(file)) {
    native_error = GetLastError();
    CloseHandle(file);
    DeleteFileW(path.c_str());
    return ThrowWin32(env, "NATIVE_FLUSH_FAILED", native_error, "FlushFileBuffers");
  }

  CloseHandle(file);

  napi_value out;
  napi_create_object(env, &out);
  SetProp(env, out, "created", MakeBool(env, true));
  SetProp(env, out, "bytesWritten", MakeDouble(env, static_cast<double>(length)));
  SetProp(env, out, "flushed", MakeBool(env, true));
  return out;
}

enum class AtomicFailpoint {
  None,
#ifdef WINHELM_NATIVE_TEST_HOOKS
  AfterCreate,
  AfterWrite,
  AfterFlush,
  CrashAfterFlush,
#endif
};

#ifdef WINHELM_NATIVE_TEST_HOOKS
AtomicFailpoint ParseFailpoint(const std::wstring& text) {
  if (text == L"after_create") return AtomicFailpoint::AfterCreate;
  if (text == L"after_write") return AtomicFailpoint::AfterWrite;
  if (text == L"after_flush") return AtomicFailpoint::AfterFlush;
  if (text == L"crash_after_flush") return AtomicFailpoint::CrashAfterFlush;
  return AtomicFailpoint::None;
}
#endif

napi_value AtomicReplaceImpl(
    napi_env env,
    const std::wstring& target,
    const uint8_t* data,
    size_t length,
    AtomicFailpoint failpoint) {
  HANDLE temp = INVALID_HANDLE_VALUE;
  std::wstring temp_path;
  DWORD native_error = ERROR_SUCCESS;
  if (!CreateUniqueTempInSameDirectory(
          target, temp, temp_path, native_error)) {
    return ThrowWin32(
        env, "ATOMIC_TEMP_CREATE_FAILED", native_error,
        "CreateFileW(CREATE_NEW temp)");
  }

#ifdef WINHELM_NATIVE_TEST_HOOKS
  auto fail_and_cleanup = [&](const char* stage) -> napi_value {
    if (temp != INVALID_HANDLE_VALUE) {
      CloseHandle(temp);
      temp = INVALID_HANDLE_VALUE;
    }
    DeleteFileW(temp_path.c_str());
    return ThrowStructured(
        env,
        "TEST_FAILPOINT",
        ERROR_GEN_FAILURE,
        std::string("Injected atomic mutation failure at ") + stage);
  };

  if (failpoint == AtomicFailpoint::AfterCreate) {
    return fail_and_cleanup("after_create");
  }
#else
  (void)failpoint;
#endif

  if (!WriteAll(temp, data, length, native_error)) {
    CloseHandle(temp);
    temp = INVALID_HANDLE_VALUE;
    DeleteFileW(temp_path.c_str());
    return ThrowWin32(env, "NATIVE_WRITE_FAILED", native_error, "WriteFile");
  }

#ifdef WINHELM_NATIVE_TEST_HOOKS
  if (failpoint == AtomicFailpoint::AfterWrite) {
    return fail_and_cleanup("after_write");
  }
#endif

  if (!FlushFileBuffers(temp)) {
    native_error = GetLastError();
    CloseHandle(temp);
    temp = INVALID_HANDLE_VALUE;
    DeleteFileW(temp_path.c_str());
    return ThrowWin32(env, "NATIVE_FLUSH_FAILED", native_error, "FlushFileBuffers");
  }

#ifdef WINHELM_NATIVE_TEST_HOOKS
  if (failpoint == AtomicFailpoint::AfterFlush) {
    return fail_and_cleanup("after_flush");
  }

  if (failpoint == AtomicFailpoint::CrashAfterFlush) {
    TerminateProcess(GetCurrentProcess(), 86);
    for (;;) Sleep(INFINITE);
  }
#endif

  CloseHandle(temp);
  temp = INVALID_HANDLE_VALUE;

  constexpr DWORD kMoveFlags =
      MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH;
  if (!MoveFileExW(temp_path.c_str(), target.c_str(), kMoveFlags)) {
    native_error = GetLastError();
    DeleteFileW(temp_path.c_str());
    return ThrowWin32(env, "ATOMIC_COMMIT_FAILED", native_error, "MoveFileExW");
  }

  napi_value out;
  napi_create_object(env, &out);
  SetProp(env, out, "bytesWritten", MakeDouble(env, static_cast<double>(length)));
  SetProp(env, out, "flushed", MakeBool(env, true));
  SetProp(env, out, "committed", MakeBool(env, true));
  SetProp(env, out, "moveFlags", MakeUint32(env, kMoveFlags));
  SetProp(env, out, "tempDirectory", MakeUtf16String(env, ParentDirectory(temp_path)));
  SetProp(env, out, "targetDirectory", MakeUtf16String(env, ParentDirectory(target)));
  return out;
}

napi_value AtomicReplace(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  size_t argc = 2;
  napi_value this_value;
  if (!GetThisAndArgs(env, info, 2, argc, argv, this_value) || argc != 2) {
    return ThrowStructured(
        env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
        "atomicReplace(path, buffer) requires exactly two arguments");
  }

  std::wstring path;
  if (!GetWideString(env, argv[0], path, "path")) return nullptr;
  const uint8_t* data = nullptr;
  size_t length = 0;
  if (!GetBuffer(env, argv[1], data, length, "buffer")) return nullptr;
  return AtomicReplaceImpl(env, path, data, length, AtomicFailpoint::None);
}

#ifdef WINHELM_NATIVE_TEST_HOOKS
napi_value AtomicReplaceTest(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  size_t argc = 3;
  napi_value this_value;
  if (!GetThisAndArgs(env, info, 3, argc, argv, this_value) || argc != 3) {
    return ThrowStructured(
        env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
        "atomicReplaceTest(path, buffer, failpoint) requires three arguments");
  }
  std::wstring path;
  if (!GetWideString(env, argv[0], path, "path")) return nullptr;
  const uint8_t* data = nullptr;
  size_t length = 0;
  if (!GetBuffer(env, argv[1], data, length, "buffer")) return nullptr;
  std::wstring failpoint_text;
  if (!GetWideString(env, argv[2], failpoint_text, "failpoint", true)) return nullptr;
  const AtomicFailpoint failpoint = ParseFailpoint(failpoint_text);
  if (failpoint == AtomicFailpoint::None && !failpoint_text.empty()) {
    return ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                           "Unknown atomic failpoint");
  }
  return AtomicReplaceImpl(env, path, data, length, failpoint);
}
#endif

enum class ProcessFailpoint {
  None,
  BeforeJobConfig,
  ForceJobConfigFailure,
  BeforeAssign,
  ForceAssignFailure,
  BeforeResume,
};

#ifdef WINHELM_NATIVE_TEST_HOOKS
ProcessFailpoint ParseProcessFailpoint(const std::wstring& text) {
  if (text == L"before_job_config") return ProcessFailpoint::BeforeJobConfig;
  if (text == L"force_job_config_failure") return ProcessFailpoint::ForceJobConfigFailure;
  if (text == L"before_assign") return ProcessFailpoint::BeforeAssign;
  if (text == L"force_assign_failure") return ProcessFailpoint::ForceAssignFailure;
  if (text == L"before_resume") return ProcessFailpoint::BeforeResume;
  return ProcessFailpoint::None;
}
#endif

void TerminateSuspendedAndClose(
    PROCESS_INFORMATION& pi,
    HANDLE job,
    bool assigned_to_job) {
  if (assigned_to_job && job) {
    TerminateJobObject(job, ERROR_PROCESS_ABORTED);
  } else if (pi.hProcess) {
    TerminateProcess(pi.hProcess, ERROR_PROCESS_ABORTED);
  }
  if (pi.hProcess) {
    WaitForSingleObject(pi.hProcess, 5000);
  }
  if (pi.hThread) CloseHandle(pi.hThread);
  if (pi.hProcess) CloseHandle(pi.hProcess);
  if (job) CloseHandle(job);
  pi.hThread = nullptr;
  pi.hProcess = nullptr;
}

napi_value ProcessWait(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 1;
  napi_value this_value;
  ProcessState* state =
      UnwrapProcess(env, info, 1, argc, argv, this_value);
  if (!state) return nullptr;

  uint32_t timeout_ms = 5000;
  if (argc == 1 && !GetUint32(env, argv[0], timeout_ms, "timeoutMs")) {
    return nullptr;
  }

  {
    std::lock_guard<std::mutex> lock(state->wait_mutex);
    if (state->wait_pending) {
      return ThrowStructured(
          env, "ASYNC_WAIT_PENDING", ERROR_BUSY,
          "An asynchronous wait is already pending on this process");
    }
  }

#ifdef WINHELM_NATIVE_TEST_HOOKS
  ++state->wait_for_single_object_calls;
#endif
  const DWORD wait_result = WaitForSingleObject(state->process, timeout_ms);
  if (wait_result == WAIT_TIMEOUT) {
    napi_value out;
    napi_create_object(env, &out);
    SetProp(env, out, "status", MakeString(env, "timeout"));
    return out;
  }
  if (wait_result != WAIT_OBJECT_0) {
    const DWORD error = GetLastError();
    return ThrowWin32(env, "PROCESS_WAIT_FAILED", error, "WaitForSingleObject");
  }

  // Deterministic finalization: when the process has exited, drain/collect
  // completion is awaited so the caller never sees a final result while
  // collector threads are still mutating stream state.
  if (state->a4) {
    JoinCollectors(state);
  }

  DWORD exit_code = 0;
  if (!GetExitCodeProcess(state->process, &exit_code)) {
    const DWORD error = GetLastError();
    return ThrowWin32(env, "PROCESS_QUERY_FAILED", error, "GetExitCodeProcess");
  }

  napi_value out;
  napi_create_object(env, &out);
  SetProp(env, out, "status", MakeString(env, "exited"));
  SetProp(env, out, "exitCode", MakeUint32(env, exit_code));
  return out;
}

napi_value ProcessTerminate(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 1;
  napi_value this_value;
  ProcessState* state =
      UnwrapProcess(env, info, 1, argc, argv, this_value);
  if (!state) return nullptr;

  uint32_t exit_code = ERROR_PROCESS_ABORTED;
  if (argc == 1 && !GetUint32(env, argv[0], exit_code, "exitCode")) {
    return nullptr;
  }

  if (!state->job) {
    return ThrowStructured(env, "JOB_HANDLE_CLOSED", ERROR_INVALID_HANDLE,
                           "Job Object handle is unavailable");
  }

#ifdef WINHELM_NATIVE_TEST_HOOKS
  ++state->terminate_job_object_calls;
#endif
  if (!TerminateJobObject(state->job, exit_code)) {
    const DWORD error = GetLastError();
    return ThrowWin32(env, "JOB_TERMINATE_FAILED", error, "TerminateJobObject");
  }

  napi_value undefined_value;
  napi_get_undefined(env, &undefined_value);
  return undefined_value;
}

napi_value ProcessIsInJob(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 0;
  napi_value this_value;
  ProcessState* state =
      UnwrapProcess(env, info, 0, argc, argv, this_value);
  if (!state) return nullptr;
  if (!state->job) {
    return ThrowStructured(env, "JOB_HANDLE_CLOSED", ERROR_INVALID_HANDLE,
                           "Job Object handle is unavailable");
  }

  BOOL result = FALSE;
  if (!IsProcessInJob(state->process, state->job, &result)) {
    const DWORD error = GetLastError();
    return ThrowWin32(env, "JOB_QUERY_FAILED", error, "IsProcessInJob");
  }
  return MakeBool(env, result == TRUE);
}

napi_value ProcessPid(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 0;
  napi_value this_value;
  ProcessState* state =
      UnwrapProcess(env, info, 0, argc, argv, this_value);
  if (!state) return nullptr;
  return MakeUint32(env, state->pid);
}

napi_value ProcessClose(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 0;
  napi_value this_value;
  if (!GetThisAndArgs(env, info, 0, argc, argv, this_value)) return nullptr;
  ProcessState* state = nullptr;
  if (napi_unwrap(env, this_value, reinterpret_cast<void**>(&state)) != napi_ok ||
      !state) {
    return ThrowStructured(env, "INVALID_NATIVE_STATE", ERROR_INVALID_HANDLE,
                           "Process state is unavailable");
  }
  if (state->closed) {
    return ThrowStructured(env, "HANDLE_CLOSED", ERROR_INVALID_HANDLE,
                           "Contained-process state is already closed");
  }
  {
    std::lock_guard<std::mutex> lock(state->wait_mutex);
    if (state->wait_pending) {
      return ThrowStructured(
          env, "ASYNC_WAIT_PENDING", ERROR_BUSY,
          "Cannot close while an asynchronous wait is pending");
    }
  }
  CloseProcessState(state);
  napi_value undefined_value;
  napi_get_undefined(env, &undefined_value);
  return undefined_value;
}

napi_value MakeNull(napi_env env) {
  napi_value out;
  napi_get_null(env, &out);
  return out;
}

bool ParseStreamName(napi_env env, napi_value value, int& index) {
  std::wstring name;
  if (!GetWideString(env, value, name, "stream")) return false;
  if (name == L"stdout") {
    index = kStreamStdout;
    return true;
  }
  if (name == L"stderr") {
    index = kStreamStderr;
    return true;
  }
  ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                  "stream must be \"stdout\" or \"stderr\"");
  return false;
}

napi_value ProcessStreamState(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 1;
  napi_value this_value;
  ProcessState* state = UnwrapProcess(env, info, 1, argc, argv, this_value);
  if (!state) return nullptr;
  if (!state->a4) {
    return ThrowStructured(
        env, "STREAMS_UNAVAILABLE", ERROR_INVALID_PARAMETER,
        "Stream state requires the governed A4 options form");
  }
  int index = 0;
  if (!ParseStreamName(env, argv[0], index)) return nullptr;

  StreamState& stream = state->streams[index];
  std::lock_guard<std::mutex> lock(stream.mutex);

  napi_value out;
  napi_create_object(env, &out);
  SetProp(env, out, "retainedBytes",
          MakeUint32(env, static_cast<uint32_t>(stream.capture.size())));
  SetProp(env, out, "totalBytes",
          MakeDouble(env, static_cast<double>(stream.total)));
  SetProp(env, out, "truncated", MakeBool(env, stream.truncated));
  SetProp(env, out, "complete", MakeBool(env, stream.done));
  if (stream.digest_ready) {
    SetProp(env, out, "sha256", MakeString(env, Hex(stream.digest, sizeof(stream.digest))));
  } else {
    SetProp(env, out, "sha256", MakeNull(env));
  }
  if (stream.has_error) {
    napi_value error;
    napi_create_object(env, &error);
    SetProp(env, error, "code", MakeString(env, "STREAM_IO_FAILED"));
    SetProp(env, error, "nativeCode", MakeUint32(env, stream.error_code));
    SetProp(env, out, "error", error);
  } else {
    SetProp(env, out, "error", MakeNull(env));
  }
  return out;
}

napi_value ProcessStreamCapture(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 1;
  napi_value this_value;
  ProcessState* state = UnwrapProcess(env, info, 1, argc, argv, this_value);
  if (!state) return nullptr;
  if (!state->a4) {
    return ThrowStructured(
        env, "STREAMS_UNAVAILABLE", ERROR_INVALID_PARAMETER,
        "Stream capture requires the governed A4 options form");
  }
  int index = 0;
  if (!ParseStreamName(env, argv[0], index)) return nullptr;

  std::string copy;
  {
    StreamState& stream = state->streams[index];
    std::lock_guard<std::mutex> lock(stream.mutex);
    copy = stream.capture;
  }

  napi_value buffer;
  if (napi_create_buffer_copy(
          env, copy.size(), copy.data(), nullptr, &buffer) != napi_ok) {
    return ThrowStructured(env, "NATIVE_BUFFER_FAILED", ERROR_INVALID_DATA,
                           "Unable to copy retained stream capture");
  }
  return buffer;
}

napi_value ProcessPeakRss(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 0;
  napi_value this_value;
  ProcessState* state = UnwrapProcess(env, info, 0, argc, argv, this_value);
  if (!state) return nullptr;

  PROCESS_MEMORY_COUNTERS counters{};
  counters.cb = sizeof(counters);
  if (!GetProcessMemoryInfo(state->process, &counters, sizeof(counters))) {
    const DWORD error = GetLastError();
    return ThrowWin32(
        env, "PEAK_RSS_UNAVAILABLE", error, "GetProcessMemoryInfo");
  }
  return MakeDouble(env, static_cast<double>(counters.PeakWorkingSetSize));
}

void WaitAsyncExecute(napi_env, void* data) {
  auto* state = static_cast<ProcessState*>(data);
  const DWORD wait_result =
      WaitForSingleObject(state->process, state->async_timeout_ms);
  if (wait_result == WAIT_OBJECT_0) {
    DWORD exit_code = 0;
    if (GetExitCodeProcess(state->process, &exit_code)) {
      state->async_exited = true;
      state->async_exit_code = exit_code;
    } else {
      state->async_wait_failed = true;
      state->async_wait_error = GetLastError();
    }
    JoinCollectors(state);
  } else if (wait_result == WAIT_TIMEOUT) {
    state->async_exited = false;
  } else {
    state->async_wait_failed = true;
    state->async_wait_error = GetLastError();
  }
}

void WaitAsyncComplete(napi_env env, napi_status status, void* data) {
  auto* state = static_cast<ProcessState*>(data);
  napi_async_work work = state->wait_work;
  napi_deferred deferred = state->wait_deferred;
  napi_ref keepalive = state->wait_keepalive;
  const bool failed = state->async_wait_failed;
  const uint32_t wait_error = state->async_wait_error;
  const bool exited = state->async_exited;
  const uint32_t exit_code = state->async_exit_code;
  {
    std::lock_guard<std::mutex> lock(state->wait_mutex);
    state->wait_pending = false;
    state->wait_work = nullptr;
    state->wait_deferred = nullptr;
    state->wait_keepalive = nullptr;
  }

  if (work) {
    napi_delete_async_work(env, work);
  }
  if (deferred && status == napi_ok) {
    if (failed) {
      napi_value message = MakeString(
          env,
          "Asynchronous contained-process wait failed with Win32 error " +
              std::to_string(wait_error));
      napi_value error;
      napi_create_error(env, nullptr, message, &error);
      SetProp(env, error, "code", MakeString(env, "PROCESS_WAIT_FAILED"));
      SetProp(env, error, "nativeCode", MakeUint32(env, wait_error));
      napi_reject_deferred(env, deferred, error);
    } else {
      napi_value out;
      napi_create_object(env, &out);
      SetProp(env, out, "status",
              MakeString(env, exited ? "exited" : "timeout"));
      if (exited) {
        SetProp(env, out, "exitCode", MakeUint32(env, exit_code));
      }
      napi_resolve_deferred(env, deferred, out);
    }
  }
  if (keepalive) {
    napi_delete_reference(env, keepalive);
  }
}

napi_value ProcessWaitAsync(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 1;
  napi_value this_value;
  ProcessState* state = UnwrapProcess(env, info, 1, argc, argv, this_value);
  if (!state) return nullptr;
  if (!state->a4) {
    return ThrowStructured(
        env, "ASYNC_WAIT_UNAVAILABLE", ERROR_INVALID_PARAMETER,
        "Asynchronous wait requires the governed A4 options form");
  }
  uint32_t timeout_ms = 5000;
  if (argc == 1 && !GetUint32(env, argv[0], timeout_ms, "timeoutMs")) {
    return nullptr;
  }

  {
    std::lock_guard<std::mutex> lock(state->wait_mutex);
    if (state->wait_pending) {
      return ThrowStructured(
          env, "ASYNC_WAIT_PENDING", ERROR_BUSY,
          "An asynchronous wait is already pending on this process");
    }
    state->wait_pending = true;
    state->async_wait_failed = false;
    state->async_exited = false;
    state->async_exit_code = 0;
    state->async_timeout_ms = timeout_ms;
  }

  napi_value resource_name;
  napi_create_string_utf8(
      env, "winhelm:contained-wait", NAPI_AUTO_LENGTH, &resource_name);
  napi_value promise;
  const napi_status created =
      napi_create_promise(env, &state->wait_deferred, &promise);
  const napi_status referenced =
      created == napi_ok
          ? napi_create_reference(env, this_value, 1, &state->wait_keepalive)
          : napi_generic_failure;
  const napi_status work_created =
      created == napi_ok && referenced == napi_ok
          ? napi_create_async_work(
                env,
                nullptr,
                resource_name,
                WaitAsyncExecute,
                WaitAsyncComplete,
                state,
                &state->wait_work)
          : napi_generic_failure;
  const napi_status queued =
      work_created == napi_ok
          ? napi_queue_async_work(env, state->wait_work)
          : napi_generic_failure;
  if (created != napi_ok || referenced != napi_ok ||
      work_created != napi_ok || queued != napi_ok) {
    napi_async_work work = state->wait_work;
    napi_ref keepalive = state->wait_keepalive;
    state->wait_work = nullptr;
    state->wait_keepalive = nullptr;
    state->wait_deferred = nullptr;
    {
      std::lock_guard<std::mutex> lock(state->wait_mutex);
      state->wait_pending = false;
    }
    if (work) napi_delete_async_work(env, work);
    if (keepalive) napi_delete_reference(env, keepalive);
    return ThrowStructured(
        env, "ASYNC_WAIT_FAILED", ERROR_INVALID_DATA,
        "Unable to enqueue the asynchronous contained-process wait");
  }
  return promise;
}

#ifdef WINHELM_NATIVE_TEST_HOOKS
napi_value ProcessTestSteps(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 0;
  napi_value this_value;
  ProcessState* state =
      UnwrapProcess(env, info, 0, argc, argv, this_value);
  if (!state) return nullptr;
  napi_value array;
  napi_create_array_with_length(env, state->steps.size(), &array);
  for (size_t i = 0; i < state->steps.size(); ++i) {
    napi_set_element(env, array, static_cast<uint32_t>(i),
                     MakeString(env, state->steps[i]));
  }
  return array;
}

napi_value ProcessTestWin32CallCounts(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 0;
  napi_value this_value;
  ProcessState* state =
      UnwrapProcess(env, info, 0, argc, argv, this_value);
  if (!state) return nullptr;

  napi_value out;
  napi_create_object(env, &out);
  SetProp(env, out, "waitForSingleObject",
          MakeUint32(env, state->wait_for_single_object_calls));
  SetProp(env, out, "terminateJobObject",
          MakeUint32(env, state->terminate_job_object_calls));
  return out;
}

napi_value ProcessTestCloseJob(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 0;
  napi_value this_value;
  ProcessState* state =
      UnwrapProcess(env, info, 0, argc, argv, this_value);
  if (!state) return nullptr;
  if (state->job) {
    CloseHandle(state->job);
    state->job = nullptr;
  }
  napi_value undefined_value;
  napi_get_undefined(env, &undefined_value);
  return undefined_value;
}

napi_value ProcessTestIsPidInJob(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 1;
  napi_value this_value;
  ProcessState* state =
      UnwrapProcess(env, info, 1, argc, argv, this_value);
  if (!state) return nullptr;
  if (argc != 1) {
    return ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                           "testIsPidInJob(pid) requires one argument");
  }
  if (!state->job) {
    return ThrowStructured(env, "JOB_HANDLE_CLOSED", ERROR_INVALID_HANDLE,
                           "Job Object handle is unavailable");
  }
  uint32_t pid = 0;
  if (!GetUint32(env, argv[0], pid, "pid")) return nullptr;

  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) {
    const DWORD error = GetLastError();
    return ThrowWin32(env, "PROCESS_OPEN_FAILED", error, "OpenProcess");
  }

  BOOL result = FALSE;
  if (!IsProcessInJob(process, state->job, &result)) {
    const DWORD error = GetLastError();
    CloseHandle(process);
    return ThrowWin32(env, "JOB_QUERY_FAILED", error, "IsProcessInJob");
  }
  CloseHandle(process);
  return MakeBool(env, result == TRUE);
}
#endif

struct SinkSpec {
  bool present = false;
  std::wstring path;
  SinkMode mode = SinkMode::CreateNew;
#ifdef WINHELM_NATIVE_TEST_HOOKS
  uint32_t test_fail_after_bytes = 0;
#endif
};

struct A4Options {
  std::vector<EnvEntry> environment;
  uint32_t capture_limit = 0;
  SinkSpec stdout_sink;
  SinkSpec stderr_sink;
};

bool CheckObjectKeys(
    napi_env env,
    napi_value object,
    const std::vector<std::wstring>& allowed,
    const char* field) {
  napi_value names;
  if (napi_get_property_names(env, object, &names) != napi_ok) {
    ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                    std::string("Unable to enumerate properties of ") + field);
    return false;
  }
  uint32_t length = 0;
  napi_get_array_length(env, names, &length);
  for (uint32_t i = 0; i < length; ++i) {
    napi_value key;
    napi_get_element(env, names, i, &key);
    std::wstring key_text;
    if (!GetWideString(env, key, key_text, "property key")) return false;
    bool known = false;
    for (const auto& candidate : allowed) {
      if (key_text == candidate) {
        known = true;
        break;
      }
    }
    if (!known) {
      ThrowStructured(
          env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
          std::string(field) + " contains an unexpected property");
      return false;
    }
  }
  return true;
}

bool IsPropertyDefined(napi_env env, napi_value object, const char* name) {
  napi_value property;
  if (napi_get_named_property(env, object, name, &property) != napi_ok) {
    return false;
  }
  napi_valuetype type;
  return napi_typeof(env, property, &type) == napi_ok &&
         type != napi_undefined && type != napi_null;
}

bool ParseSinkMode(napi_env env, napi_value value, SinkMode& mode) {
  std::wstring text;
  if (!GetWideString(env, value, text, "sink mode")) return false;
  if (text == L"create_new") {
    mode = SinkMode::CreateNew;
    return true;
  }
  if (text == L"overwrite") {
    mode = SinkMode::Overwrite;
    return true;
  }
  if (text == L"append") {
    mode = SinkMode::Append;
    return true;
  }
  ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                  "sink mode must be create_new, overwrite, or append");
  return false;
}

bool ParseSinkDescriptor(napi_env env, napi_value value, SinkSpec& sink) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_object) {
    ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                    "sink descriptor must be an object");
    return false;
  }
#ifdef WINHELM_NATIVE_TEST_HOOKS
  if (!CheckObjectKeys(
          env, value, {L"path", L"mode", L"testFailAfterBytes"},
          "sink descriptor")) {
    return false;
  }
#else
  if (!CheckObjectKeys(env, value, {L"path", L"mode"}, "sink descriptor")) {
    return false;
  }
#endif
  napi_value path_value;
  napi_get_named_property(env, value, "path", &path_value);
  if (!GetWideString(env, path_value, sink.path, "sink path")) return false;
  if (!IsAbsoluteWindowsPath(sink.path)) {
    ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                    "sink path must be an absolute Windows path");
    return false;
  }
  napi_value mode_value;
  napi_get_named_property(env, value, "mode", &mode_value);
  if (!ParseSinkMode(env, mode_value, sink.mode)) return false;
#ifdef WINHELM_NATIVE_TEST_HOOKS
  if (IsPropertyDefined(env, value, "testFailAfterBytes")) {
    napi_value fail_value;
    napi_get_named_property(env, value, "testFailAfterBytes", &fail_value);
    if (!GetUint32(env, fail_value, sink.test_fail_after_bytes,
                   "testFailAfterBytes")) {
      return false;
    }
  }
#endif
  sink.present = true;
  return true;
}

bool ParseEnvironmentEntries(
    napi_env env,
    napi_value value,
    std::vector<EnvEntry>& out) {
  bool is_array = false;
  if (napi_is_array(env, value, &is_array) != napi_ok || !is_array) {
    ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                    "environment must be an array of {name, value} entries");
    return false;
  }
  uint32_t length = 0;
  napi_get_array_length(env, value, &length);
  if (length > kMaxEnvEntries) {
    ThrowStructured(env, "INPUT_TOO_LARGE", ERROR_BUFFER_OVERFLOW,
                    "environment has too many entries");
    return false;
  }
  out.resize(length);
  for (uint32_t i = 0; i < length; ++i) {
    napi_value item;
    napi_get_element(env, value, i, &item);
    napi_valuetype type;
    if (napi_typeof(env, item, &type) != napi_ok || type != napi_object) {
      ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                      "environment entry must be an object");
      return false;
    }
    if (!CheckObjectKeys(env, item, {L"name", L"value"},
                         "environment entry")) {
      return false;
    }
    napi_value name_value;
    napi_get_named_property(env, item, "name", &name_value);
    if (!GetWideString(env, name_value, out[i].name, "environment name")) {
      return false;
    }
    if (out[i].name.find(L'=') != std::wstring::npos) {
      ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                      "environment name must not contain '='");
      return false;
    }
    napi_value entry_value;
    napi_get_named_property(env, item, "value", &entry_value);
    if (!GetWideString(env, entry_value, out[i].value, "environment value",
                       true)) {
      return false;
    }
  }
  bool comparison_ok = true;
  std::sort(out.begin(), out.end(), [&comparison_ok](const EnvEntry& a, const EnvEntry& b) {
    bool ok = true;
    const int result = EnvNameWindowsCompare(a.name, b.name, ok);
    if (!ok) {
      comparison_ok = false;
      return false;
    }
    return result == CSTR_LESS_THAN;
  });
  if (!comparison_ok) {
    ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                    "environment name comparison failed");
    return false;
  }
  for (size_t i = 1; i < out.size(); ++i) {
    bool ok = true;
    const int result = EnvNameWindowsCompare(out[i - 1].name, out[i].name, ok);
    if (!ok) {
      ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                      "environment name comparison failed");
      return false;
    }
    if (result == CSTR_EQUAL) {
      ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                      "environment contains duplicate case-insensitive names");
      return false;
    }
  }
  return true;
}

bool ParseA4Options(napi_env env, napi_value value, A4Options& options) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_object) {
    ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                    "governed options must be an object");
    return false;
  }
  if (!CheckObjectKeys(
          env, value,
          {L"environment", L"captureLimitBytes", L"stdoutSink",
           L"stderrSink"},
          "governed options")) {
    return false;
  }
  napi_value environment_value;
  napi_get_named_property(env, value, "environment", &environment_value);
  napi_valuetype environment_type;
  napi_typeof(env, environment_value, &environment_type);
  if (environment_type == napi_undefined || environment_type == napi_null) {
    ThrowStructured(
        env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
        "options.environment is required (use [] for an explicitly empty "
        "environment)");
    return false;
  }
  if (!ParseEnvironmentEntries(env, environment_value, options.environment)) {
    return false;
  }

  napi_value capture_value;
  napi_get_named_property(env, value, "captureLimitBytes", &capture_value);
  napi_valuetype capture_type;
  napi_typeof(env, capture_value, &capture_type);
  if (capture_type == napi_undefined || capture_type == napi_null) {
    ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                    "options.captureLimitBytes is required");
    return false;
  }
  if (!GetUint32(env, capture_value, options.capture_limit,
                 "captureLimitBytes")) {
    return false;
  }
  if (options.capture_limit > kMaxCaptureBytes) {
    ThrowStructured(env, "INPUT_TOO_LARGE", ERROR_BUFFER_OVERFLOW,
                    "captureLimitBytes exceeds 128 MiB");
    return false;
  }

  napi_value stdout_value;
  napi_get_named_property(env, value, "stdoutSink", &stdout_value);
  if (IsPropertyDefined(env, value, "stdoutSink") &&
      !ParseSinkDescriptor(env, stdout_value, options.stdout_sink)) {
    return false;
  }
  napi_value stderr_value;
  napi_get_named_property(env, value, "stderrSink", &stderr_value);
  if (IsPropertyDefined(env, value, "stderrSink") &&
      !ParseSinkDescriptor(env, stderr_value, options.stderr_sink)) {
    return false;
  }
  return true;
}

napi_value SpawnContainedA4Impl(
    napi_env env,
    const std::wstring& command,
    const std::vector<std::wstring>& args,
    const std::wstring* cwd,
    const A4Options& options,
    ProcessFailpoint failpoint) {
#ifndef WINHELM_NATIVE_TEST_HOOKS
  (void)failpoint;
#endif
  if (!IsAbsoluteWindowsPath(command)) {
    return ThrowStructured(
        env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
        "command must be an absolute Windows executable path");
  }

  std::wstring command_line = BuildCommandLine(command, args);
  if (command_line.size() >= 32767) {
    return ThrowStructured(
        env, "INPUT_TOO_LARGE", ERROR_BUFFER_OVERFLOW,
        "Windows command line exceeds the 32766-character limit");
  }
  std::vector<wchar_t> mutable_command(command_line.begin(),
                                       command_line.end());
  mutable_command.push_back(L'\0');

  std::vector<wchar_t> environment_block;
  if (!BuildEnvironmentBlock(options.environment, environment_block)) {
    return ThrowStructured(
        env, "INPUT_TOO_LARGE", ERROR_BUFFER_OVERFLOW,
        "Environment block exceeds the 32767-character Windows limit");
  }

  // Defense-in-depth only; the public STREAM_REDIRECTION_COLLISION policy
  // remains a decision of the future TypeScript/M1 layer.
  if (options.stdout_sink.present && options.stderr_sink.present) {
    bool sink_compare_ok = true;
    const int sink_compare = EnvNameWindowsCompare(
        options.stdout_sink.path, options.stderr_sink.path, sink_compare_ok);
    if (!sink_compare_ok) {
      return ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                             "Sink path comparison failed");
    }
    if (sink_compare == CSTR_EQUAL) {
      return ThrowStructured(env, "SINK_PATH_CONFLICT", ERROR_INVALID_PARAMETER,
                             "stdout and stderr sinks must not target the same "
                             "path");
    }
  }

  // Sinks open before process creation so an invalid sink cannot produce
  // unrecorded child execution.
  HANDLE sink_handles[2] = {nullptr, nullptr};
  for (int i = 0; i < 2; ++i) {
    const SinkSpec& spec =
        i == kStreamStdout ? options.stdout_sink : options.stderr_sink;
    if (!spec.present) continue;
    DWORD sink_error = 0;
    if (!OpenSinkHandle(spec.path, spec.mode, sink_handles[i], sink_error)) {
      for (int j = 0; j < i; ++j) {
        if (sink_handles[j]) CloseHandle(sink_handles[j]);
      }
      const char* code =
          (sink_error == ERROR_FILE_EXISTS || sink_error == ERROR_ALREADY_EXISTS)
              ? "SINK_ALREADY_EXISTS"
              : "SINK_OPEN_FAILED";
      return ThrowWin32(env, code, sink_error, "CreateFileW(sink)");
    }
  }

  // Deterministic non-interactive child stdin: an EOF-producing NUL handle.
  SECURITY_ATTRIBUTES inherit_sa{};
  inherit_sa.nLength = sizeof(inherit_sa);
  inherit_sa.bInheritHandle = TRUE;
  HANDLE stdin_handle = CreateFileW(
      L"\\\\.\\NUL",
      GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      &inherit_sa,
      OPEN_EXISTING,
      0,
      nullptr);
  if (stdin_handle == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    for (HANDLE sink : sink_handles) {
      if (sink) CloseHandle(sink);
    }
    return ThrowWin32(env, "CHILD_STDIN_FAILED", error, "CreateFileW(NUL)");
  }

  HANDLE stdout_read = nullptr;
  HANDLE stdout_write = nullptr;
  HANDLE stderr_read = nullptr;
  HANDLE stderr_write = nullptr;
  if (!CreatePipe(&stdout_read, &stdout_write, &inherit_sa, 0) ||
      !CreatePipe(&stderr_read, &stderr_write, &inherit_sa, 0)) {
    const DWORD error = GetLastError();
    CloseHandle(stdin_handle);
    if (stdout_read) CloseHandle(stdout_read);
    if (stdout_write) CloseHandle(stdout_write);
    if (stderr_read) CloseHandle(stderr_read);
    if (stderr_write) CloseHandle(stderr_write);
    for (HANDLE sink : sink_handles) {
      if (sink) CloseHandle(sink);
    }
    return ThrowWin32(env, "CHILD_PIPE_FAILED", error, "CreatePipe");
  }
  SetHandleInformation(stdout_read, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(stderr_read, HANDLE_FLAG_INHERIT, 0);

  auto* state = new ProcessState();
  state->a4 = true;
  state->streams[kStreamStdout].read_end = stdout_read;
  state->streams[kStreamStderr].read_end = stderr_read;
  state->streams[kStreamStdout].sink = sink_handles[kStreamStdout];
  state->streams[kStreamStderr].sink = sink_handles[kStreamStderr];
  state->streams[kStreamStdout].capture_limit = options.capture_limit;
  state->streams[kStreamStderr].capture_limit = options.capture_limit;
#ifdef WINHELM_NATIVE_TEST_HOOKS
  state->streams[kStreamStdout].test_sink_fail_after_bytes =
      options.stdout_sink.test_fail_after_bytes;
  state->streams[kStreamStderr].test_sink_fail_after_bytes =
      options.stderr_sink.test_fail_after_bytes;
#endif
  if (!CreateStreamHash(state->streams[kStreamStdout]) ||
      !CreateStreamHash(state->streams[kStreamStderr])) {
    CloseHandle(stdin_handle);
    CloseHandle(stdout_write);
    CloseHandle(stderr_write);
    CloseProcessState(state);
    delete state;
    return ThrowStructured(env, "STREAM_HASH_FAILED", ERROR_INVALID_DATA,
                           "Unable to initialize incremental SHA-256 for the "
                           "output collectors");
  }

  // Restricted standard-handle inheritance: bInheritHandles=TRUE is accepted
  // only together with an explicit PROC_THREAD_ATTRIBUTE_HANDLE_LIST
  // allowlist, so the Job handle, parent read ends, sink handles, and any
  // unrelated inheritable server handle cannot reach the child.
  HANDLE child_handles[3] = {stdin_handle, stdout_write, stderr_write};
  SIZE_T attribute_size = 0;
  InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_size);
  LPPROC_THREAD_ATTRIBUTE_LIST attribute_list =
      static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(
          HeapAlloc(GetProcessHeap(), 0, attribute_size));
  bool attribute_initialized = false;
  if (attribute_list &&
      InitializeProcThreadAttributeList(
          attribute_list, 1, 0, &attribute_size)) {
    attribute_initialized = true;
  }
  const bool attribute_ready =
      attribute_initialized &&
      UpdateProcThreadAttribute(
          attribute_list,
          0,
          PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
          child_handles,
          sizeof(child_handles),
          nullptr,
          nullptr);
  if (!attribute_ready) {
    const DWORD error = attribute_list ? GetLastError()
                                       : ERROR_NOT_ENOUGH_MEMORY;
    if (attribute_initialized) {
      DeleteProcThreadAttributeList(attribute_list);
    }
    if (attribute_list) {
      HeapFree(GetProcessHeap(), 0, attribute_list);
    }
    CloseHandle(stdin_handle);
    CloseHandle(stdout_write);
    CloseHandle(stderr_write);
    CloseProcessState(state);
    delete state;
    return ThrowWin32(
        env, "HANDLE_LIST_FAILED", error, "InitializeProcThreadAttributeList");
  }

  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = stdin_handle;
  startup.StartupInfo.hStdOutput = stdout_write;
  startup.StartupInfo.hStdError = stderr_write;
  startup.lpAttributeList = attribute_list;

  PROCESS_INFORMATION pi{};
  const DWORD creation_flags = CREATE_SUSPENDED |
                               CREATE_UNICODE_ENVIRONMENT |
                               EXTENDED_STARTUPINFO_PRESENT;
  if (!CreateProcessW(
          command.c_str(),
          mutable_command.data(),
          nullptr,
          nullptr,
          TRUE,
          creation_flags,
          environment_block.data(),
          cwd ? cwd->c_str() : nullptr,
          &startup.StartupInfo,
          &pi)) {
    const DWORD error = GetLastError();
    DeleteProcThreadAttributeList(attribute_list);
    HeapFree(GetProcessHeap(), 0, attribute_list);
    CloseHandle(stdin_handle);
    CloseHandle(stdout_write);
    CloseHandle(stderr_write);
    CloseProcessState(state);
    delete state;
    return ThrowWin32(env, "CREATE_PROCESS_FAILED", error, "CreateProcessW");
  }

  // Parent copies of the child-side std handles are closed before resume so
  // stream EOF is observable and no write end leaks in the parent.
  CloseHandle(stdin_handle);
  CloseHandle(stdout_write);
  CloseHandle(stderr_write);
  DeleteProcThreadAttributeList(attribute_list);
  HeapFree(GetProcessHeap(), 0, attribute_list);

  state->process = pi.hProcess;
  state->thread = pi.hThread;
  state->pid = pi.dwProcessId;

  state->job = CreateJobObjectW(nullptr, nullptr);
  if (!state->job) {
    const DWORD error = GetLastError();
    CloseProcessState(state);
    delete state;
    return ThrowWin32(env, "JOB_CREATE_FAILED", error, "CreateJobObjectW");
  }

#ifdef WINHELM_NATIVE_TEST_HOOKS
  if (failpoint == ProcessFailpoint::BeforeJobConfig) {
    CloseProcessState(state);
    delete state;
    return ThrowStructured(env, "TEST_FAILPOINT", ERROR_GEN_FAILURE,
                           "Injected failure before Job Object configuration");
  }

  if (failpoint == ProcessFailpoint::ForceJobConfigFailure) {
    if (SetInformationJobObject(
            state->job,
            JobObjectExtendedLimitInformation,
            nullptr,
            0)) {
      CloseProcessState(state);
      delete state;
      return ThrowStructured(env, "TEST_HOOK_FAILED", ERROR_INVALID_DATA,
                             "Forced Job configuration failure unexpectedly "
                             "succeeded");
    }
    const DWORD error = GetLastError();
    CloseProcessState(state);
    delete state;
    return ThrowWin32(env, "JOB_CONFIG_FAILED", error,
                      "SetInformationJobObject(forced failure)");
  }
#endif

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(
          state->job,
          JobObjectExtendedLimitInformation,
          &limits,
          sizeof(limits))) {
    const DWORD error = GetLastError();
    CloseProcessState(state);
    delete state;
    return ThrowWin32(env, "JOB_CONFIG_FAILED", error,
                      "SetInformationJobObject");
  }

#ifdef WINHELM_NATIVE_TEST_HOOKS
  if (failpoint == ProcessFailpoint::BeforeAssign) {
    CloseProcessState(state);
    delete state;
    return ThrowStructured(env, "TEST_FAILPOINT", ERROR_GEN_FAILURE,
                           "Injected failure before AssignProcessToJobObject");
  }

  if (failpoint == ProcessFailpoint::ForceAssignFailure) {
    if (AssignProcessToJobObject(nullptr, state->process)) {
      CloseProcessState(state);
      delete state;
      return ThrowStructured(env, "TEST_HOOK_FAILED", ERROR_INVALID_DATA,
                             "Forced Job assignment failure unexpectedly "
                             "succeeded");
    }
    const DWORD error = GetLastError();
    CloseProcessState(state);
    delete state;
    return ThrowWin32(env, "JOB_ASSIGN_FAILED", error,
                      "AssignProcessToJobObject(forced failure)");
  }
#endif

  if (!AssignProcessToJobObject(state->job, state->process)) {
    const DWORD error = GetLastError();
    CloseProcessState(state);
    delete state;
    return ThrowWin32(env, "JOB_ASSIGN_FAILED", error,
                      "AssignProcessToJobObject");
  }

#ifdef WINHELM_NATIVE_TEST_HOOKS
  if (failpoint == ProcessFailpoint::BeforeResume) {
    CloseProcessState(state);
    delete state;
    return ThrowStructured(env, "TEST_FAILPOINT", ERROR_GEN_FAILURE,
                           "Injected failure before ResumeThread");
  }
#endif

  // Collectors may begin blocking on the pipes before resume; all
  // containment-critical setup above is already complete.
  state->collectors[kStreamStdout] =
      std::thread(CollectorMain, state, kStreamStdout);
  state->collectors[kStreamStderr] =
      std::thread(CollectorMain, state, kStreamStderr);
  state->collectors_started = true;

  const DWORD resume_result = ResumeThread(state->thread);
  if (resume_result == static_cast<DWORD>(-1)) {
    const DWORD error = GetLastError();
    CloseProcessState(state);
    delete state;
    return ThrowWin32(env, "PROCESS_RESUME_FAILED", error, "ResumeThread");
  }

#ifdef WINHELM_NATIVE_TEST_HOOKS
  state->steps = {
      "CREATE_SUSPENDED",
      "JOB_CONFIGURED",
      "ASSIGNED_TO_JOB",
      "RESUMED",
  };
#endif

  napi_value object;
  napi_create_object(env, &object);
  if (napi_wrap(env, object, state, ProcessFinalize, nullptr, nullptr) !=
      napi_ok) {
    CloseProcessState(state);
    delete state;
    return ThrowStructured(env, "NATIVE_WRAP_FAILED", ERROR_INVALID_DATA,
                           "Unable to wrap contained-process state");
  }

  std::vector<napi_property_descriptor> props = {
      {"wait", nullptr, ProcessWait, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"waitAsync", nullptr, ProcessWaitAsync, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"terminate", nullptr, ProcessTerminate, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"isInJob", nullptr, ProcessIsInJob, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"streamState", nullptr, ProcessStreamState, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"streamCapture", nullptr, ProcessStreamCapture, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"peakRss", nullptr, ProcessPeakRss, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"pid", nullptr, ProcessPid, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, ProcessClose, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
#ifdef WINHELM_NATIVE_TEST_HOOKS
  props.push_back({"testSteps", nullptr, ProcessTestSteps, nullptr, nullptr, nullptr, napi_default, nullptr});
  props.push_back({"testWin32CallCounts", nullptr, ProcessTestWin32CallCounts, nullptr, nullptr, nullptr, napi_default, nullptr});
  props.push_back({"testCloseJob", nullptr, ProcessTestCloseJob, nullptr, nullptr, nullptr, napi_default, nullptr});
  props.push_back({"testIsPidInJob", nullptr, ProcessTestIsPidInJob, nullptr, nullptr, nullptr, napi_default, nullptr});
#endif
  napi_define_properties(env, object, props.size(), props.data());
  return object;
}

napi_value SpawnContainedImpl(
    napi_env env,
    const std::wstring& command,
    const std::vector<std::wstring>& args,
    const std::wstring* cwd,
    ProcessFailpoint failpoint) {
#ifndef WINHELM_NATIVE_TEST_HOOKS
  (void)failpoint;
#endif
  if (!IsAbsoluteWindowsPath(command)) {
    return ThrowStructured(
        env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
        "command must be an absolute Windows executable path");
  }

  std::wstring command_line = BuildCommandLine(command, args);
  if (command_line.size() >= 32767) {
    return ThrowStructured(
        env, "INPUT_TOO_LARGE", ERROR_BUFFER_OVERFLOW,
        "Windows command line exceeds the 32766-character limit");
  }
  std::vector<wchar_t> mutable_command(
      command_line.begin(), command_line.end());
  mutable_command.push_back(L'\0');

  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION pi{};

  const DWORD creation_flags =
      CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;
  if (!CreateProcessW(
          command.c_str(),
          mutable_command.data(),
          nullptr,
          nullptr,
          FALSE,
          creation_flags,
          nullptr,
          cwd ? cwd->c_str() : nullptr,
          &startup,
          &pi)) {
    const DWORD error = GetLastError();
    return ThrowWin32(env, "CREATE_PROCESS_FAILED", error, "CreateProcessW");
  }

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (!job) {
    const DWORD error = GetLastError();
    TerminateSuspendedAndClose(pi, nullptr, false);
    return ThrowWin32(env, "JOB_CREATE_FAILED", error, "CreateJobObjectW");
  }

#ifdef WINHELM_NATIVE_TEST_HOOKS
  if (failpoint == ProcessFailpoint::BeforeJobConfig) {
    TerminateSuspendedAndClose(pi, job, false);
    return ThrowStructured(env, "TEST_FAILPOINT", ERROR_GEN_FAILURE,
                           "Injected failure before Job Object configuration");
  }
#endif

#ifdef WINHELM_NATIVE_TEST_HOOKS
  if (failpoint == ProcessFailpoint::ForceJobConfigFailure) {
    if (SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            nullptr,
            0)) {
      TerminateSuspendedAndClose(pi, job, false);
      return ThrowStructured(env, "TEST_HOOK_FAILED", ERROR_INVALID_DATA,
                             "Forced Job configuration failure unexpectedly succeeded");
    }
    const DWORD error = GetLastError();
    TerminateSuspendedAndClose(pi, job, false);
    return ThrowWin32(env, "JOB_CONFIG_FAILED", error,
                      "SetInformationJobObject(forced failure)");
  }
#endif

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(
          job,
          JobObjectExtendedLimitInformation,
          &limits,
          sizeof(limits))) {
    const DWORD error = GetLastError();
    TerminateSuspendedAndClose(pi, job, false);
    return ThrowWin32(env, "JOB_CONFIG_FAILED", error,
                      "SetInformationJobObject");
  }

#ifdef WINHELM_NATIVE_TEST_HOOKS
  if (failpoint == ProcessFailpoint::BeforeAssign) {
    TerminateSuspendedAndClose(pi, job, false);
    return ThrowStructured(env, "TEST_FAILPOINT", ERROR_GEN_FAILURE,
                           "Injected failure before AssignProcessToJobObject");
  }
#endif

#ifdef WINHELM_NATIVE_TEST_HOOKS
  if (failpoint == ProcessFailpoint::ForceAssignFailure) {
    if (AssignProcessToJobObject(nullptr, pi.hProcess)) {
      TerminateSuspendedAndClose(pi, job, false);
      return ThrowStructured(env, "TEST_HOOK_FAILED", ERROR_INVALID_DATA,
                             "Forced Job assignment failure unexpectedly succeeded");
    }
    const DWORD error = GetLastError();
    TerminateSuspendedAndClose(pi, job, false);
    return ThrowWin32(env, "JOB_ASSIGN_FAILED", error,
                      "AssignProcessToJobObject(forced failure)");
  }
#endif

  if (!AssignProcessToJobObject(job, pi.hProcess)) {
    const DWORD error = GetLastError();
    TerminateSuspendedAndClose(pi, job, false);
    return ThrowWin32(env, "JOB_ASSIGN_FAILED", error,
                      "AssignProcessToJobObject");
  }

#ifdef WINHELM_NATIVE_TEST_HOOKS
  if (failpoint == ProcessFailpoint::BeforeResume) {
    TerminateSuspendedAndClose(pi, job, true);
    return ThrowStructured(env, "TEST_FAILPOINT", ERROR_GEN_FAILURE,
                           "Injected failure before ResumeThread");
  }
#endif

  const DWORD resume_result = ResumeThread(pi.hThread);
  if (resume_result == static_cast<DWORD>(-1)) {
    const DWORD error = GetLastError();
    TerminateSuspendedAndClose(pi, job, true);
    return ThrowWin32(env, "PROCESS_RESUME_FAILED", error, "ResumeThread");
  }

  auto* state = new ProcessState();
  state->process = pi.hProcess;
  state->thread = pi.hThread;
  state->job = job;
  state->pid = pi.dwProcessId;
#ifdef WINHELM_NATIVE_TEST_HOOKS
  state->steps = {
      "CREATE_SUSPENDED",
      "JOB_CONFIGURED",
      "ASSIGNED_TO_JOB",
      "RESUMED",
  };
#endif

  napi_value object;
  napi_create_object(env, &object);
  if (napi_wrap(env, object, state, ProcessFinalize, nullptr, nullptr) != napi_ok) {
    CloseProcessState(state);
    delete state;
    return ThrowStructured(env, "NATIVE_WRAP_FAILED", ERROR_INVALID_DATA,
                           "Unable to wrap contained-process state");
  }

  std::vector<napi_property_descriptor> props = {
      {"wait", nullptr, ProcessWait, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"terminate", nullptr, ProcessTerminate, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"isInJob", nullptr, ProcessIsInJob, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"pid", nullptr, ProcessPid, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, ProcessClose, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
#ifdef WINHELM_NATIVE_TEST_HOOKS
  props.push_back({"testSteps", nullptr, ProcessTestSteps, nullptr, nullptr, nullptr, napi_default, nullptr});
  props.push_back({"testWin32CallCounts", nullptr, ProcessTestWin32CallCounts, nullptr, nullptr, nullptr, napi_default, nullptr});
  props.push_back({"testCloseJob", nullptr, ProcessTestCloseJob, nullptr, nullptr, nullptr, napi_default, nullptr});
  props.push_back({"testIsPidInJob", nullptr, ProcessTestIsPidInJob, nullptr, nullptr, nullptr, napi_default, nullptr});
#endif
  napi_define_properties(env, object, props.size(), props.data());
  return object;
}

napi_value SpawnContainedCommon(
    napi_env env,
    napi_callback_info info,
    bool allow_failpoint) {
  napi_value argv[5];
#ifdef WINHELM_NATIVE_TEST_HOOKS
  const size_t max_args = allow_failpoint ? 5 : 4;
#else
  (void)allow_failpoint;
  const size_t max_args = 4;
#endif
  napi_value this_value;
  size_t argc = max_args;
  if (!GetThisAndArgs(env, info, max_args, argc, argv, this_value)) {
    return nullptr;
  }
  const size_t min_args = 2;
  if (argc < min_args || argc > max_args) {
#ifdef WINHELM_NATIVE_TEST_HOOKS
    const char* message = allow_failpoint
        ? "spawnContainedTest(command, args, cwd?, failpoint?, options?) has "
          "invalid arity"
        : "spawnContained(command, args, cwd?, options?) has invalid arity";
#else
    const char* message = "spawnContained(command, args, cwd?, options?) has "
                          "invalid arity";
#endif
    return ThrowStructured(
        env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER, message);
  }

  std::wstring command;
  if (!GetWideString(env, argv[0], command, "command")) return nullptr;
  std::vector<std::wstring> args;
  if (!GetStringArray(env, argv[1], args, "args")) return nullptr;

  std::wstring cwd_text;
  const std::wstring* cwd = nullptr;
  if (argc >= 3) {
    napi_valuetype type;
    napi_typeof(env, argv[2], &type);
    if (type != napi_undefined && type != napi_null) {
      if (!GetWideString(env, argv[2], cwd_text, "cwd")) return nullptr;
      cwd = &cwd_text;
    }
  }

  ProcessFailpoint failpoint = ProcessFailpoint::None;
#ifdef WINHELM_NATIVE_TEST_HOOKS
  if (allow_failpoint && argc >= 4) {
    napi_valuetype type;
    napi_typeof(env, argv[3], &type);
    if (type != napi_undefined && type != napi_null) {
      std::wstring failpoint_text;
      if (!GetWideString(env, argv[3], failpoint_text, "failpoint", true)) {
        return nullptr;
      }
      failpoint = ParseProcessFailpoint(failpoint_text);
      if (failpoint == ProcessFailpoint::None && !failpoint_text.empty()) {
        return ThrowStructured(env, "INVALID_ARGUMENT",
                               ERROR_INVALID_PARAMETER,
                               "Unknown process failpoint");
      }
    }
  }
#endif

  // Governed A4 form: the final argument is the purpose-specific options
  // object; its presence selects the explicit-environment/restricted-handle
  // path, keeping the legacy NB1 form fully functional.
  const size_t options_index = allow_failpoint ? 4 : 3;
  if (argc > options_index) {
    A4Options options;
    if (!ParseA4Options(env, argv[options_index], options)) return nullptr;
    return SpawnContainedA4Impl(
        env, command, args, cwd, options, failpoint);
  }

  return SpawnContainedImpl(env, command, args, cwd, failpoint);
}

napi_value SpawnContained(napi_env env, napi_callback_info info) {
  return SpawnContainedCommon(env, info, false);
}

#ifdef WINHELM_NATIVE_TEST_HOOKS
napi_value SpawnContainedTest(napi_env env, napi_callback_info info) {
  return SpawnContainedCommon(env, info, true);
}

napi_value CurrentProcessHandleCount(napi_env env, napi_callback_info) {
  DWORD count = 0;
  if (!GetProcessHandleCount(GetCurrentProcess(), &count)) {
    const DWORD error = GetLastError();
    return ThrowWin32(env, "HANDLE_COUNT_FAILED", error,
                      "GetProcessHandleCount");
  }
  return MakeUint32(env, count);
}

// Harmless test-only inheritable sentinel used to prove that unrelated
// inheritable handles never reach the child through the restricted
// handle-list path. The sentinel file is opened with an exclusive share mode,
// so a child that inherited it could never re-open the file.
HANDLE g_test_sentinel_handle = nullptr;

napi_value CreateTestInheritableSentinel(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc = 1;
  napi_value this_value;
  if (!GetThisAndArgs(env, info, 1, argc, argv, this_value) || argc != 1) {
    return ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                           "createTestInheritableSentinel(path) requires one "
                           "argument");
  }
  std::wstring path;
  if (!GetWideString(env, argv[0], path, "path")) return nullptr;
  if (g_test_sentinel_handle) {
    return ThrowStructured(env, "SENTINEL_ALREADY_HELD", ERROR_INVALID_HANDLE,
                           "A test sentinel handle is already held");
  }
  SECURITY_ATTRIBUTES inherit_sa{};
  inherit_sa.nLength = sizeof(inherit_sa);
  inherit_sa.bInheritHandle = TRUE;
  HANDLE file = CreateFileW(
      path.c_str(),
      GENERIC_READ,
      0,
      &inherit_sa,
      OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL,
      nullptr);
  if (file == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    return ThrowWin32(env, "SENTINEL_OPEN_FAILED", error, "CreateFileW");
  }
  g_test_sentinel_handle = file;
  napi_value undefined_value;
  napi_get_undefined(env, &undefined_value);
  return undefined_value;
}

napi_value ReleaseTestInheritableSentinel(napi_env env, napi_callback_info) {
  if (g_test_sentinel_handle) {
    CloseHandle(g_test_sentinel_handle);
    g_test_sentinel_handle = nullptr;
  }
  napi_value undefined_value;
  napi_get_undefined(env, &undefined_value);
  return undefined_value;
}
#endif

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
      {"stableReadOpen", nullptr, StableReadOpen, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"createExclusive", nullptr, CreateExclusive, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"atomicReplace", nullptr, AtomicReplace, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"spawnContained", nullptr, SpawnContained, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 4, props);

#ifdef WINHELM_NATIVE_TEST_HOOKS
  napi_property_descriptor test_props[] = {
      {"atomicReplaceTest", nullptr, AtomicReplaceTest, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"spawnContainedTest", nullptr, SpawnContainedTest, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"getCurrentProcessHandleCount", nullptr, CurrentProcessHandleCount, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"createTestInheritableSentinel", nullptr, CreateTestInheritableSentinel, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"releaseTestInheritableSentinel", nullptr, ReleaseTestInheritableSentinel, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 5, test_props);
#endif

  SetProp(env, exports, "abi", MakeString(env, "node-api"));
  SetProp(env, exports, "napiVersion", MakeUint32(env, NAPI_VERSION));
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
