#include <windows.h>
#include <bcrypt.h>
#include <node_api.h>

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cwchar>
#include <iomanip>
#include <limits>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#pragma comment(lib, "bcrypt.lib")

namespace {

constexpr size_t kMaxStringChars = 32768;
constexpr size_t kMaxBufferBytes = 128ull * 1024ull * 1024ull;
std::atomic<unsigned long long> g_temp_counter{0};

struct StableReadState {
  HANDLE handle = INVALID_HANDLE_VALUE;
  bool closed = false;
};

struct ProcessState {
  HANDLE process = nullptr;
  HANDLE thread = nullptr;
  HANDLE job = nullptr;
  DWORD pid = 0;
  bool closed = false;
#ifdef WINHELM_NATIVE_TEST_HOOKS
  std::vector<std::string> steps;
#endif
};

void CloseStable(StableReadState* state) {
  if (!state || state->closed) return;
  if (state->handle != INVALID_HANDLE_VALUE) {
    CloseHandle(state->handle);
    state->handle = INVALID_HANDLE_VALUE;
  }
  state->closed = true;
}

void CloseProcessState(ProcessState* state) {
  if (!state || state->closed) return;
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
  if (napi_get_value_uint32(env, value, &out) != napi_ok) {
    ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                    std::string("Unable to read ") + field_name);
    return false;
  }
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
  CloseProcessState(state);
  napi_value undefined_value;
  napi_get_undefined(env, &undefined_value);
  return undefined_value;
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
  napi_value argv[4];
#ifdef WINHELM_NATIVE_TEST_HOOKS
  size_t argc = allow_failpoint ? 4 : 3;
  const size_t max_args = allow_failpoint ? 4 : 3;
#else
  (void)allow_failpoint;
  size_t argc = 3;
  const size_t max_args = 3;
#endif
  napi_value this_value;
  if (!GetThisAndArgs(env, info, max_args, argc, argv, this_value)) {
    return nullptr;
  }
  const size_t min_args = 2;
  if (argc < min_args || argc > max_args) {
#ifdef WINHELM_NATIVE_TEST_HOOKS
    const char* message = allow_failpoint
        ? "spawnContainedTest(command, args, cwd?, failpoint?) has invalid arity"
        : "spawnContained(command, args, cwd?) has invalid arity";
#else
    const char* message = "spawnContained(command, args, cwd?) has invalid arity";
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
    std::wstring failpoint_text;
    if (!GetWideString(env, argv[3], failpoint_text, "failpoint", true)) return nullptr;
    failpoint = ParseProcessFailpoint(failpoint_text);
    if (failpoint == ProcessFailpoint::None && !failpoint_text.empty()) {
      return ThrowStructured(env, "INVALID_ARGUMENT", ERROR_INVALID_PARAMETER,
                             "Unknown process failpoint");
    }
  }
#else
  (void)allow_failpoint;
#endif

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
  };
  napi_define_properties(env, exports, 3, test_props);
#endif

  SetProp(env, exports, "abi", MakeString(env, "node-api"));
  SetProp(env, exports, "napiVersion", MakeUint32(env, NAPI_VERSION));
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
