#include "guarded_marker_commit.h"

#include <windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <memory>
#include <mutex>
#include <new>
#include <sstream>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace winhelm::guarded_marker {
namespace {

constexpr size_t kMaxStringChars = 32768;
constexpr size_t kMaxMarkerBytes = 16ull * 1024ull * 1024ull;
constexpr size_t kHashChunkBytes = 64ull * 1024ull;
constexpr size_t kTransactionTokenBytes = 32;

struct FileIdentity {
  uint32_t volume_serial_number = 0;
  uint32_t file_index_high = 0;
  uint32_t file_index_low = 0;
};

bool operator==(const FileIdentity& left, const FileIdentity& right) {
  return left.volume_serial_number == right.volume_serial_number &&
         left.file_index_high == right.file_index_high &&
         left.file_index_low == right.file_index_low;
}

class ScopedHandle {
 public:
  ScopedHandle() = default;
  explicit ScopedHandle(HANDLE value) : value_(value) {}
  ~ScopedHandle() { reset(); }

  ScopedHandle(const ScopedHandle&) = delete;
  ScopedHandle& operator=(const ScopedHandle&) = delete;

  ScopedHandle(ScopedHandle&& other) noexcept : value_(other.release()) {}
  ScopedHandle& operator=(ScopedHandle&& other) noexcept {
    if (this != &other) reset(other.release());
    return *this;
  }

  bool valid() const {
    return value_ != nullptr && value_ != INVALID_HANDLE_VALUE;
  }
  HANDLE get() const { return value_; }
  HANDLE release() {
    HANDLE value = value_;
    value_ = INVALID_HANDLE_VALUE;
    return value;
  }
  void reset(HANDLE value = INVALID_HANDLE_VALUE) {
    if (valid()) CloseHandle(value_);
    value_ = value;
  }

 private:
  HANDLE value_ = INVALID_HANDLE_VALUE;
};

struct GuardError {
  std::string code = "COMMIT_FAILED";
  DWORD native_code = ERROR_GEN_FAILURE;
  std::string phase;
  std::string message;
  std::wstring backup_path;
  std::wstring stage_path;
};

struct BeginRequest {
  std::wstring target_path;
  const uint8_t* replacement = nullptr;
  size_t replacement_length = 0;
  std::string expected_current_sha256;
  FileIdentity expected_current_identity;
};

struct BeginResult {
  std::string transaction_id;
  std::string sha256;
  FileIdentity identity;
  std::wstring backup_path;
  size_t bytes_written = 0;
};

#ifdef WINHELM_NATIVE_TEST_HOOKS
struct TestControl {
  std::string barrier_phase;
  std::string crash_phase;
};
#endif

struct TransactionState {
  // Declaration order is deliberate: reverse destruction closes stage first,
  // then the retired current object, then the bound parent namespace.
  ScopedHandle parent;
  ScopedHandle current;
  ScopedHandle stage;
  std::wstring target_path;
  std::wstring parent_path;
  std::wstring stage_path;
  std::wstring backup_path;
  std::wstring target_name;
  std::wstring stage_name;
  std::wstring backup_name;
  std::string replacement_sha256;
  FileIdentity stage_identity;
  bool retired = false;
  bool published = false;
  bool acknowledgeable = false;
};

std::mutex g_transactions_mutex;
std::unordered_map<std::string, std::shared_ptr<TransactionState>>
    g_transactions;
std::atomic<unsigned long long> g_name_counter{0};

void SetError(
    GuardError& error,
    const char* code,
    DWORD native_code,
    const char* phase,
    const std::string& message) {
  error.code = code;
  error.native_code = native_code;
  error.phase = phase;
  error.message = message;
}

std::string Win32Message(const char* operation, DWORD native_code) {
  std::ostringstream message;
  message << operation << " failed with Win32 error " << native_code;
  return message.str();
}

std::string Hex(const uint8_t* bytes, size_t length) {
  static constexpr char kDigits[] = "0123456789abcdef";
  std::string value(length * 2, '0');
  for (size_t index = 0; index < length; ++index) {
    value[index * 2] = kDigits[(bytes[index] >> 4) & 0x0f];
    value[index * 2 + 1] = kDigits[bytes[index] & 0x0f];
  }
  return value;
}

bool NormalizeSha256(std::string& value) {
  if (value.size() != 64) return false;
  for (char& ch : value) {
    const unsigned char byte = static_cast<unsigned char>(ch);
    if (!std::isxdigit(byte)) return false;
    ch = static_cast<char>(std::tolower(byte));
  }
  return true;
}

bool IsAbsoluteWindowsPath(const std::wstring& path) {
  if (path.size() >= 3 &&
      ((path[0] >= L'A' && path[0] <= L'Z') ||
       (path[0] >= L'a' && path[0] <= L'z')) &&
      path[1] == L':' && (path[2] == L'\\' || path[2] == L'/')) {
    return true;
  }
  return path.size() >= 2 &&
         ((path[0] == L'\\' && path[1] == L'\\') ||
          (path[0] == L'/' && path[1] == L'/'));
}

bool WindowsEqualsIgnoreCase(
    const std::wstring& left,
    const wchar_t* right) {
  const int result = CompareStringOrdinal(
      left.data(),
      static_cast<int>(left.size()),
      right,
      -1,
      TRUE);
  return result == CSTR_EQUAL;
}

std::wstring ParentDirectory(const std::wstring& path) {
  const size_t position = path.find_last_of(L"\\/");
  if (position == std::wstring::npos) return L"";
  if (position == 2 && path.size() >= 3 && path[1] == L':') {
    return path.substr(0, 3);
  }
  if (position == 0) return path.substr(0, 1);
  return path.substr(0, position);
}

std::wstring FileNamePart(const std::wstring& path) {
  const size_t position = path.find_last_of(L"\\/");
  return position == std::wstring::npos ? path : path.substr(position + 1);
}

std::wstring JoinPath(const std::wstring& parent, const std::wstring& name) {
  std::wstring result = parent;
  if (!result.empty() && result.back() != L'\\' && result.back() != L'/') {
    result.push_back(L'\\');
  }
  result += name;
  return result;
}

std::wstring WidenAscii(const std::string& value) {
  std::wstring result;
  result.reserve(value.size());
  for (char ch : value) result.push_back(static_cast<wchar_t>(ch));
  return result;
}

bool RandomToken(std::string& token, DWORD& native_error) {
  std::array<uint8_t, kTransactionTokenBytes> bytes{};
  const NTSTATUS status = BCryptGenRandom(
      nullptr,
      bytes.data(),
      static_cast<ULONG>(bytes.size()),
      BCRYPT_USE_SYSTEM_PREFERRED_RNG);
  if (status < 0) {
    native_error = static_cast<DWORD>(status);
    return false;
  }
  token = Hex(bytes.data(), bytes.size());
  native_error = ERROR_SUCCESS;
  return true;
}

bool HashBytes(
    const uint8_t* data,
    size_t length,
    std::string& sha256,
    DWORD& native_error) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD object_length = 0;
  DWORD result_length = 0;
  NTSTATUS status = BCryptOpenAlgorithmProvider(
      &algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0);
  if (status < 0) {
    native_error = static_cast<DWORD>(status);
    return false;
  }
  status = BCryptGetProperty(
      algorithm,
      BCRYPT_OBJECT_LENGTH,
      reinterpret_cast<PUCHAR>(&object_length),
      sizeof(object_length),
      &result_length,
      0);
  if (status < 0) {
    native_error = static_cast<DWORD>(status);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    return false;
  }
  std::vector<uint8_t> object(object_length);
  status = BCryptCreateHash(
      algorithm,
      &hash,
      object.data(),
      static_cast<ULONG>(object.size()),
      nullptr,
      0,
      0);
  if (status < 0) {
    native_error = static_cast<DWORD>(status);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    return false;
  }
  size_t offset = 0;
  while (offset < length) {
    const ULONG chunk = static_cast<ULONG>(std::min<size_t>(
        length - offset, std::numeric_limits<ULONG>::max()));
    status = BCryptHashData(
        hash, const_cast<PUCHAR>(data + offset), chunk, 0);
    if (status < 0) {
      native_error = static_cast<DWORD>(status);
      BCryptDestroyHash(hash);
      BCryptCloseAlgorithmProvider(algorithm, 0);
      return false;
    }
    offset += chunk;
  }
  std::array<uint8_t, 32> digest{};
  status = BCryptFinishHash(
      hash, digest.data(), static_cast<ULONG>(digest.size()), 0);
  BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  if (status < 0) {
    native_error = static_cast<DWORD>(status);
    return false;
  }
  sha256 = Hex(digest.data(), digest.size());
  native_error = ERROR_SUCCESS;
  return true;
}

bool HashHandle(
    HANDLE file,
    std::string& sha256,
    uint64_t& byte_count,
    DWORD& native_error) {
  LARGE_INTEGER zero{};
  if (!SetFilePointerEx(file, zero, nullptr, FILE_BEGIN)) {
    native_error = GetLastError();
    return false;
  }

  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD object_length = 0;
  DWORD result_length = 0;
  NTSTATUS status = BCryptOpenAlgorithmProvider(
      &algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0);
  if (status < 0) {
    native_error = static_cast<DWORD>(status);
    return false;
  }
  status = BCryptGetProperty(
      algorithm,
      BCRYPT_OBJECT_LENGTH,
      reinterpret_cast<PUCHAR>(&object_length),
      sizeof(object_length),
      &result_length,
      0);
  if (status < 0) {
    native_error = static_cast<DWORD>(status);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    return false;
  }
  std::vector<uint8_t> object(object_length);
  status = BCryptCreateHash(
      algorithm,
      &hash,
      object.data(),
      static_cast<ULONG>(object.size()),
      nullptr,
      0,
      0);
  if (status < 0) {
    native_error = static_cast<DWORD>(status);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    return false;
  }

  std::array<uint8_t, kHashChunkBytes> buffer{};
  byte_count = 0;
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
      BCryptCloseAlgorithmProvider(algorithm, 0);
      return false;
    }
    if (bytes_read == 0) break;
    status = BCryptHashData(hash, buffer.data(), bytes_read, 0);
    if (status < 0) {
      native_error = static_cast<DWORD>(status);
      BCryptDestroyHash(hash);
      BCryptCloseAlgorithmProvider(algorithm, 0);
      return false;
    }
    byte_count += bytes_read;
  }

  std::array<uint8_t, 32> digest{};
  status = BCryptFinishHash(
      hash, digest.data(), static_cast<ULONG>(digest.size()), 0);
  BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  if (status < 0) {
    native_error = static_cast<DWORD>(status);
    return false;
  }
  if (!SetFilePointerEx(file, zero, nullptr, FILE_BEGIN)) {
    native_error = GetLastError();
    return false;
  }
  sha256 = Hex(digest.data(), digest.size());
  native_error = ERROR_SUCCESS;
  return true;
}

bool WriteAll(
    HANDLE file,
    const uint8_t* data,
    size_t length,
    DWORD& native_error) {
  size_t offset = 0;
  while (offset < length) {
    const DWORD chunk = static_cast<DWORD>(std::min<size_t>(
        length - offset, std::numeric_limits<DWORD>::max()));
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
  if (!FlushFileBuffers(file)) {
    native_error = GetLastError();
    return false;
  }
  native_error = ERROR_SUCCESS;
  return true;
}

bool QueryIdentity(
    HANDLE file,
    FileIdentity& identity,
    DWORD& native_error) {
  BY_HANDLE_FILE_INFORMATION information{};
  if (!GetFileInformationByHandle(file, &information)) {
    native_error = GetLastError();
    return false;
  }
  identity.volume_serial_number = information.dwVolumeSerialNumber;
  identity.file_index_high = information.nFileIndexHigh;
  identity.file_index_low = information.nFileIndexLow;
  native_error = ERROR_SUCCESS;
  return true;
}

bool QuerySafeAttributes(
    HANDLE file,
    bool require_directory,
    DWORD& native_error) {
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  if (!GetFileInformationByHandleEx(
          file, FileAttributeTagInfo, &attributes, sizeof(attributes))) {
    native_error = GetLastError();
    return false;
  }
  if ((attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    native_error = ERROR_REPARSE_TAG_MISMATCH;
    return false;
  }
  const bool is_directory =
      (attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  if (is_directory != require_directory) {
    native_error = require_directory ? ERROR_DIRECTORY : ERROR_FILE_INVALID;
    return false;
  }
  native_error = ERROR_SUCCESS;
  return true;
}

bool MarkDeleteOnClose(HANDLE file, DWORD& native_error) {
  FILE_DISPOSITION_INFO disposition{};
  disposition.DeleteFile = TRUE;
  if (!SetFileInformationByHandle(
          file,
          FileDispositionInfo,
          &disposition,
          sizeof(disposition))) {
    native_error = GetLastError();
    return false;
  }
  native_error = ERROR_SUCCESS;
  return true;
}

struct IoStatusBlockLocal {
  union {
    LONG status;
    PVOID pointer;
  } value;
  ULONG_PTR information;
};

using NtSetInformationFileFunction =
    LONG(NTAPI*)(HANDLE, IoStatusBlockLocal*, PVOID, ULONG, ULONG);
using RtlNtStatusToDosErrorFunction = ULONG(WINAPI*)(LONG);

bool RenameHeldObject(
    HANDLE file,
    HANDLE parent,
    const std::wstring& destination_name,
    DWORD& native_error) {
  if (destination_name.empty()) {
    native_error = ERROR_INVALID_NAME;
    return false;
  }
  const size_t name_bytes = destination_name.size() * sizeof(wchar_t);
  const size_t total_bytes = offsetof(FILE_RENAME_INFO, FileName) + name_bytes;
  if (name_bytes > std::numeric_limits<DWORD>::max() ||
      total_bytes > std::numeric_limits<DWORD>::max()) {
    native_error = ERROR_BUFFER_OVERFLOW;
    return false;
  }
  std::vector<uint8_t> buffer(total_bytes, 0);
  auto* information = reinterpret_cast<FILE_RENAME_INFO*>(buffer.data());
  information->ReplaceIfExists = FALSE;
  information->RootDirectory = parent;
  information->FileNameLength = static_cast<DWORD>(name_bytes);
  std::memcpy(information->FileName, destination_name.data(), name_bytes);
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (ntdll == nullptr) {
    native_error = GetLastError();
    return false;
  }
  const FARPROC raw_nt_set = GetProcAddress(ntdll, "NtSetInformationFile");
  const FARPROC raw_status_to_error =
      GetProcAddress(ntdll, "RtlNtStatusToDosError");
  if (raw_nt_set == nullptr) {
    native_error = ERROR_PROC_NOT_FOUND;
    return false;
  }
  NtSetInformationFileFunction nt_set = nullptr;
  RtlNtStatusToDosErrorFunction status_to_error = nullptr;
  static_assert(sizeof(nt_set) == sizeof(raw_nt_set));
  static_assert(sizeof(status_to_error) == sizeof(raw_status_to_error));
  std::memcpy(&nt_set, &raw_nt_set, sizeof(nt_set));
  std::memcpy(
      &status_to_error, &raw_status_to_error, sizeof(status_to_error));

  IoStatusBlockLocal io_status{};
  constexpr ULONG kFileRenameInformation = 10;
  const LONG status = nt_set(
      file,
      &io_status,
      information,
      static_cast<ULONG>(buffer.size()),
      kFileRenameInformation);
  if (status < 0) {
    native_error = status_to_error != nullptr
        ? static_cast<DWORD>(status_to_error(status))
        : ERROR_GEN_FAILURE;
    return false;
  }
  native_error = ERROR_SUCCESS;
  return true;
}

bool PathProof(
    const std::wstring& path,
    bool directory,
    FileIdentity& identity,
    std::string* sha256,
    uint64_t* byte_count,
    DWORD& native_error) {
  DWORD flags = FILE_FLAG_OPEN_REPARSE_POINT;
  if (directory) flags |= FILE_FLAG_BACKUP_SEMANTICS;
  const DWORD access = FILE_READ_ATTRIBUTES | (directory ? 0 : GENERIC_READ);
  ScopedHandle handle(CreateFileW(
      path.c_str(),
      access,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr,
      OPEN_EXISTING,
      flags,
      nullptr));
  if (!handle.valid()) {
    native_error = GetLastError();
    return false;
  }
  if (!QuerySafeAttributes(handle.get(), directory, native_error) ||
      !QueryIdentity(handle.get(), identity, native_error)) {
    return false;
  }
  if (!directory && sha256 != nullptr && byte_count != nullptr) {
    if (!HashHandle(handle.get(), *sha256, *byte_count, native_error)) {
      return false;
    }
  }
  native_error = ERROR_SUCCESS;
  return true;
}

void EraseTransaction(const std::string& token) {
  std::lock_guard<std::mutex> lock(g_transactions_mutex);
  g_transactions.erase(token);
}

bool RegisterTransaction(
    const std::string& token,
    const std::shared_ptr<TransactionState>& state,
    GuardError& error) {
  try {
    std::lock_guard<std::mutex> lock(g_transactions_mutex);
    const auto inserted = g_transactions.emplace(token, state);
    if (!inserted.second) {
      SetError(
          error,
          "COMMIT_FAILED",
          ERROR_ALREADY_EXISTS,
          "TOKEN_PREPARE",
          "Unable to reserve a unique guarded marker transaction token");
      return false;
    }
  } catch (const std::bad_alloc&) {
    SetError(
        error,
        "COMMIT_FAILED",
        ERROR_NOT_ENOUGH_MEMORY,
        "TOKEN_PREPARE",
        "Unable to retain guarded marker transaction state");
    return false;
  }
  return true;
}

void MakeAcknowledgeable(const std::string& token) {
  std::lock_guard<std::mutex> lock(g_transactions_mutex);
  const auto found = g_transactions.find(token);
  if (found != g_transactions.end()) found->second->acknowledgeable = true;
}

bool CleanupBeforeRetire(
    const std::string& token,
    const std::shared_ptr<TransactionState>& state,
    GuardError& error) {
  if (state->stage.valid()) {
    DWORD cleanup_error = ERROR_SUCCESS;
    if (!MarkDeleteOnClose(state->stage.get(), cleanup_error)) {
      SetError(
          error,
          "RECOVERY_REQUIRED",
          cleanup_error,
          "STAGE_CLEANUP",
          Win32Message("SetFileInformationByHandle(FileDispositionInfo)",
                       cleanup_error));
      error.stage_path = state->stage_path;
    }
  }
  EraseTransaction(token);
  return false;
}

bool FinishAfterRetire(
    const std::string& token,
    const std::shared_ptr<TransactionState>& state,
    GuardError& error) {
  error.backup_path = state->backup_path;
  error.stage_path = state->published ? state->target_path : state->stage_path;
  EraseTransaction(token);
  return false;
}

bool TargetNowExists(const std::wstring& target_path) {
  ScopedHandle target(CreateFileW(
      target_path.c_str(),
      FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr));
  if (target.valid()) return true;
  const DWORD error = GetLastError();
  return error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND;
}

#ifdef WINHELM_NATIVE_TEST_HOOKS
bool WideToUtf8(
    const std::wstring& value,
    std::string& output,
    DWORD& native_error) {
  if (value.empty()) {
    output.clear();
    native_error = ERROR_SUCCESS;
    return true;
  }
  const int needed = WideCharToMultiByte(
      CP_UTF8,
      WC_ERR_INVALID_CHARS,
      value.data(),
      static_cast<int>(value.size()),
      nullptr,
      0,
      nullptr,
      nullptr);
  if (needed <= 0) {
    native_error = GetLastError();
    return false;
  }
  output.resize(static_cast<size_t>(needed));
  const int written = WideCharToMultiByte(
      CP_UTF8,
      WC_ERR_INVALID_CHARS,
      value.data(),
      static_cast<int>(value.size()),
      output.data(),
      needed,
      nullptr,
      nullptr);
  if (written != needed) {
    native_error = GetLastError();
    return false;
  }
  native_error = ERROR_SUCCESS;
  return true;
}

bool WriteStdout(const std::string& value, DWORD& native_error) {
  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  if (output == nullptr || output == INVALID_HANDLE_VALUE) {
    native_error = GetLastError();
    return false;
  }
  size_t offset = 0;
  while (offset < value.size()) {
    const DWORD chunk = static_cast<DWORD>(std::min<size_t>(
        value.size() - offset, std::numeric_limits<DWORD>::max()));
    DWORD written = 0;
    if (!WriteFile(output, value.data() + offset, chunk, &written, nullptr) ||
        written == 0) {
      native_error = GetLastError();
      if (native_error == ERROR_SUCCESS) native_error = ERROR_WRITE_FAULT;
      return false;
    }
    offset += written;
  }
  native_error = ERROR_SUCCESS;
  return true;
}

bool WaitForTestContinue(DWORD& native_error) {
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  if (input == nullptr || input == INVALID_HANDLE_VALUE) {
    native_error = GetLastError();
    return false;
  }
  std::string line;
  for (;;) {
    char ch = 0;
    DWORD read = 0;
    if (!ReadFile(input, &ch, 1, &read, nullptr)) {
      native_error = GetLastError();
      return false;
    }
    if (read == 0) {
      native_error = ERROR_BROKEN_PIPE;
      return false;
    }
    if (ch == '\n') break;
    if (ch != '\r') line.push_back(ch);
    if (line.size() > 64) {
      native_error = ERROR_INVALID_DATA;
      return false;
    }
  }
  if (line != "continue") {
    native_error = ERROR_INVALID_DATA;
    return false;
  }
  native_error = ERROR_SUCCESS;
  return true;
}

bool RunTestBarrier(
    const TestControl* control,
    const char* phase,
    const TransactionState& state,
    DWORD& native_error) {
  if (control == nullptr || control->barrier_phase != phase) return true;
  std::string stage_path;
  std::string backup_path;
  if (!WideToUtf8(state.stage_path, stage_path, native_error) ||
      !WideToUtf8(state.backup_path, backup_path, native_error)) {
    return false;
  }
  std::ostringstream signal;
  signal << "BARRIER=" << phase << "\n"
         << "STAGE_PATH=" << stage_path << "\n"
         << "BACKUP_PATH=" << backup_path << "\n"
         << "READY=1\n";
  return WriteStdout(signal.str(), native_error) &&
         WaitForTestContinue(native_error);
}

void MaybeCrash(const TestControl* control, const char* phase, UINT exit_code) {
  if (control != nullptr && control->crash_phase == phase) {
    ExitProcess(exit_code);
  }
}
#endif

bool BeginCore(
    BeginRequest request,
    BeginResult& result,
    GuardError& error
#ifdef WINHELM_NATIVE_TEST_HOOKS
    , const TestControl* test_control
#endif
    ) {
  if (!IsAbsoluteWindowsPath(request.target_path)) {
    SetError(
        error,
        "INVALID_ARGUMENT",
        ERROR_INVALID_PARAMETER,
        "VALIDATE",
        "targetPath must be an absolute Windows path");
    return false;
  }
  if (request.replacement_length > kMaxMarkerBytes) {
    SetError(
        error,
        "INVALID_ARGUMENT",
        ERROR_FILE_TOO_LARGE,
        "VALIDATE",
        "replacementBuffer exceeds the 16 MiB marker limit");
    return false;
  }
  if (request.replacement_length > 0 && request.replacement == nullptr) {
    SetError(
        error,
        "INVALID_ARGUMENT",
        ERROR_INVALID_PARAMETER,
        "VALIDATE",
        "replacementBuffer is invalid");
    return false;
  }
  if (!NormalizeSha256(request.expected_current_sha256)) {
    SetError(
        error,
        "INVALID_ARGUMENT",
        ERROR_INVALID_PARAMETER,
        "VALIDATE",
        "expectedCurrentSha256 must be exactly 64 hexadecimal characters");
    return false;
  }

  const std::wstring parent_path = ParentDirectory(request.target_path);
  const std::wstring target_name = FileNamePart(request.target_path);
  if (parent_path.empty() || target_name.empty() || target_name == L"." ||
      target_name == L"..") {
    SetError(
        error,
        "INVALID_ARGUMENT",
        ERROR_INVALID_NAME,
        "VALIDATE",
        "targetPath must name a file inside an immediate parent directory");
    return false;
  }
  if (!WindowsEqualsIgnoreCase(
          target_name, L"winhelm.active-backend.json")) {
    SetError(
        error,
        "INVALID_ARGUMENT",
        ERROR_INVALID_NAME,
        "VALIDATE",
        "targetPath must name winhelm.active-backend.json");
    return false;
  }

  DWORD native_error = ERROR_SUCCESS;
  std::string replacement_sha256;
  if (!HashBytes(
          request.replacement,
          request.replacement_length,
          replacement_sha256,
          native_error)) {
    SetError(
        error,
        "COMMIT_FAILED",
        native_error,
        "REPLACEMENT_HASH",
        "Unable to hash the intended marker replacement");
    return false;
  }

  std::string token;
  if (!RandomToken(token, native_error)) {
    SetError(
        error,
        "COMMIT_FAILED",
        native_error,
        "TOKEN_PREPARE",
        "Unable to create an opaque guarded marker transaction token");
    return false;
  }

  std::shared_ptr<TransactionState> state;
  try {
    state = std::make_shared<TransactionState>();
    const unsigned long long serial = ++g_name_counter;
    const std::wstring suffix =
        WidenAscii(token.substr(0, 24)) + L"." +
        std::to_wstring(GetCurrentProcessId()) + L"." +
        std::to_wstring(serial);
    state->target_path = request.target_path;
    state->parent_path = parent_path;
    state->target_name = target_name;
    state->stage_name = target_name + L".winhelm-guard-stage." + suffix;
    state->backup_name = target_name + L".winhelm-guard-backup." + suffix;
    state->stage_path = JoinPath(parent_path, state->stage_name);
    state->backup_path = JoinPath(parent_path, state->backup_name);
    state->replacement_sha256 = replacement_sha256;
  } catch (const std::bad_alloc&) {
    SetError(
        error,
        "COMMIT_FAILED",
        ERROR_NOT_ENOUGH_MEMORY,
        "TOKEN_PREPARE",
        "Unable to allocate guarded marker transaction state");
    return false;
  }
  if (!RegisterTransaction(token, state, error)) return false;

  state->parent.reset(CreateFileW(
      state->parent_path.c_str(),
      FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr));
  if (!state->parent.valid()) {
    native_error = GetLastError();
    SetError(
        error,
        "COMMIT_FAILED",
        native_error,
        "PARENT_BIND",
        Win32Message("CreateFileW(parent)", native_error));
    return CleanupBeforeRetire(token, state, error);
  }
  FileIdentity parent_identity;
  if (!QuerySafeAttributes(state->parent.get(), true, native_error) ||
      !QueryIdentity(state->parent.get(), parent_identity, native_error)) {
    SetError(
        error,
        "COMMIT_FAILED",
        native_error,
        "PARENT_BIND",
        "The immediate parent namespace is unsafe or cannot be identified");
    return CleanupBeforeRetire(token, state, error);
  }

  state->stage.reset(CreateFileW(
      state->stage_path.c_str(),
      GENERIC_READ | GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ,
      nullptr,
      CREATE_NEW,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH |
          FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr));
  if (!state->stage.valid()) {
    native_error = GetLastError();
    SetError(
        error,
        "COMMIT_FAILED",
        native_error,
        "STAGE_CREATE",
        Win32Message("CreateFileW(stage, CREATE_NEW)", native_error));
    return CleanupBeforeRetire(token, state, error);
  }
  if (!WriteAll(
          state->stage.get(),
          request.replacement,
          request.replacement_length,
          native_error)) {
    SetError(
        error,
        "COMMIT_FAILED",
        native_error,
        "STAGE_WRITE",
        Win32Message("WriteFile/FlushFileBuffers(stage)", native_error));
    return CleanupBeforeRetire(token, state, error);
  }

  std::string staged_sha256;
  uint64_t staged_bytes = 0;
  if (!QuerySafeAttributes(state->stage.get(), false, native_error) ||
      !QueryIdentity(
          state->stage.get(), state->stage_identity, native_error) ||
      !HashHandle(
          state->stage.get(), staged_sha256, staged_bytes, native_error)) {
    SetError(
        error,
        "COMMIT_FAILED",
        native_error,
        "STAGE_PROOF",
        "Unable to prove the held stage object");
    return CleanupBeforeRetire(token, state, error);
  }
  if (staged_sha256 != replacement_sha256 ||
      staged_bytes != request.replacement_length) {
    SetError(
        error,
        "COMMIT_FAILED",
        ERROR_INVALID_DATA,
        "STAGE_PROOF",
        "The held stage bytes do not equal the intended replacement");
    return CleanupBeforeRetire(token, state, error);
  }

  state->current.reset(CreateFileW(
      state->target_path.c_str(),
      GENERIC_READ | DELETE | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
      nullptr));
  if (!state->current.valid()) {
    native_error = GetLastError();
    if (native_error == ERROR_FILE_NOT_FOUND ||
        native_error == ERROR_PATH_NOT_FOUND) {
      SetError(
          error,
          "TARGET_ABSENT",
          native_error,
          "CURRENT_OPEN",
          "The expected current marker is absent");
    } else {
      SetError(
          error,
          "TARGET_CHANGED",
          native_error,
          "CURRENT_OPEN",
          Win32Message("CreateFileW(current guard)", native_error));
    }
    return CleanupBeforeRetire(token, state, error);
  }
  if (!QuerySafeAttributes(state->current.get(), false, native_error)) {
    SetError(
        error,
        "TARGET_CHANGED",
        native_error,
        "CURRENT_REPARSE",
        "The expected current marker is a reparse point or non-file object");
    return CleanupBeforeRetire(token, state, error);
  }

  FileIdentity current_identity;
  std::string current_sha256;
  uint64_t current_bytes = 0;
  if (!QueryIdentity(state->current.get(), current_identity, native_error) ||
      !HashHandle(
          state->current.get(),
          current_sha256,
          current_bytes,
          native_error)) {
    SetError(
        error,
        "COMMIT_FAILED",
        native_error,
        "CURRENT_PROOF",
        "Unable to prove the held current marker object");
    return CleanupBeforeRetire(token, state, error);
  }
  if (current_sha256 != request.expected_current_sha256 ||
      current_bytes > kMaxMarkerBytes ||
      !(current_identity == request.expected_current_identity)) {
    SetError(
        error,
        "TARGET_CHANGED",
        ERROR_INVALID_DATA,
        "CURRENT_PROOF",
        "The held current marker does not match explicit expected authority");
    return CleanupBeforeRetire(token, state, error);
  }

#ifdef WINHELM_NATIVE_TEST_HOOKS
  if (!RunTestBarrier(test_control, "guard", *state, native_error)) {
    SetError(
        error,
        "COMMIT_FAILED",
        native_error,
        "TEST_GUARD_BARRIER",
        "The deterministic guard barrier failed");
    return CleanupBeforeRetire(token, state, error);
  }
  MaybeCrash(test_control, "before-retire", 91);
#endif

  if (!RenameHeldObject(
          state->current.get(),
          state->parent.get(),
          state->backup_name,
          native_error)) {
    SetError(
        error,
        "COMMIT_FAILED",
        native_error,
        "RETIRE",
        Win32Message("SetFileInformationByHandle(retire)", native_error));
    return CleanupBeforeRetire(token, state, error);
  }
  state->retired = true;

#ifdef WINHELM_NATIVE_TEST_HOOKS
  if (!RunTestBarrier(test_control, "retire", *state, native_error)) {
    SetError(
        error,
        "RECOVERY_REQUIRED",
        native_error,
        "TEST_RETIRE_BARRIER",
        "The deterministic retire barrier failed after authority retirement");
    return FinishAfterRetire(token, state, error);
  }
  MaybeCrash(test_control, "after-retire", 92);
#endif

  if (!RenameHeldObject(
          state->stage.get(),
          state->parent.get(),
          state->target_name,
          native_error)) {
    if (TargetNowExists(state->target_path)) {
      SetError(
          error,
          "TARGET_CHANGED",
          native_error,
          "PUBLISH",
          "A competitor created the authoritative target; it was preserved");
    } else {
      SetError(
          error,
          "RECOVERY_REQUIRED",
          native_error,
          "PUBLISH",
          Win32Message("SetFileInformationByHandle(publish)", native_error));
    }
    return FinishAfterRetire(token, state, error);
  }
  state->published = true;

#ifdef WINHELM_NATIVE_TEST_HOOKS
  if (!RunTestBarrier(test_control, "publish", *state, native_error)) {
    SetError(
        error,
        "RECOVERY_REQUIRED",
        native_error,
        "TEST_PUBLISH_BARRIER",
        "The deterministic publish barrier failed before identity proof");
    return FinishAfterRetire(token, state, error);
  }
  MaybeCrash(test_control, "after-publish", 93);
#endif

  FileIdentity published_identity;
  std::string published_sha256;
  uint64_t published_bytes = 0;
  if (!QueryIdentity(state->stage.get(), published_identity, native_error) ||
      !HashHandle(
          state->stage.get(),
          published_sha256,
          published_bytes,
          native_error)) {
    SetError(
        error,
        "RECOVERY_REQUIRED",
        native_error,
        "PUBLISHED_HANDLE_PROOF",
        "Unable to prove the published object through the held stage handle");
    return FinishAfterRetire(token, state, error);
  }
  if (!(published_identity == state->stage_identity) ||
      published_sha256 != replacement_sha256 ||
      published_bytes != request.replacement_length) {
    SetError(
        error,
        "RECOVERY_REQUIRED",
        ERROR_INVALID_DATA,
        "PUBLISHED_HANDLE_PROOF",
        "Published bytes or identity do not equal the held stage object");
    return FinishAfterRetire(token, state, error);
  }

  FileIdentity target_identity;
  std::string target_sha256;
  uint64_t target_bytes = 0;
  if (!PathProof(
          state->target_path,
          false,
          target_identity,
          &target_sha256,
          &target_bytes,
          native_error) ||
      !(target_identity == state->stage_identity) ||
      target_sha256 != replacement_sha256 ||
      target_bytes != request.replacement_length) {
    if (native_error == ERROR_SUCCESS) native_error = ERROR_INVALID_DATA;
    SetError(
        error,
        "RECOVERY_REQUIRED",
        native_error,
        "TARGET_PATH_PROOF",
        "The authoritative target path does not resolve to the held stage object");
    return FinishAfterRetire(token, state, error);
  }

  FileIdentity parent_identity_now;
  if (!PathProof(
          state->parent_path,
          true,
          parent_identity_now,
          nullptr,
          nullptr,
          native_error) ||
      !(parent_identity_now == parent_identity)) {
    if (native_error == ERROR_SUCCESS) native_error = ERROR_INVALID_DATA;
    SetError(
        error,
        "RECOVERY_REQUIRED",
        native_error,
        "PARENT_PATH_PROOF",
        "The immediate parent path no longer resolves to the bound namespace");
    return FinishAfterRetire(token, state, error);
  }

  MakeAcknowledgeable(token);
  result.transaction_id = token;
  result.sha256 = published_sha256;
  result.identity = published_identity;
  result.backup_path = state->backup_path;
  result.bytes_written = request.replacement_length;
  return true;
}

napi_value MakeString(napi_env env, const std::string& value) {
  napi_value result;
  napi_create_string_utf8(env, value.c_str(), value.size(), &result);
  return result;
}

napi_value MakeWideString(napi_env env, const std::wstring& value) {
  napi_value result;
  napi_create_string_utf16(
      env,
      reinterpret_cast<const char16_t*>(value.data()),
      value.size(),
      &result);
  return result;
}

napi_value MakeUint32(napi_env env, uint32_t value) {
  napi_value result;
  napi_create_uint32(env, value, &result);
  return result;
}

napi_value MakeDouble(napi_env env, double value) {
  napi_value result;
  napi_create_double(env, value, &result);
  return result;
}

napi_value MakeBoolean(napi_env env, bool value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

void SetProperty(
    napi_env env,
    napi_value object,
    const char* name,
    napi_value value) {
  napi_set_named_property(env, object, name, value);
}

napi_value ThrowGuardError(napi_env env, const GuardError& error) {
  napi_value message = MakeString(env, error.message);
  napi_value exception;
  napi_create_error(env, nullptr, message, &exception);
  SetProperty(env, exception, "code", MakeString(env, error.code));
  SetProperty(
      env, exception, "nativeCode", MakeUint32(env, error.native_code));
  if (!error.phase.empty()) {
    SetProperty(env, exception, "phase", MakeString(env, error.phase));
  }
  if (!error.backup_path.empty()) {
    SetProperty(
        env, exception, "backupPath", MakeWideString(env, error.backup_path));
  }
  if (!error.stage_path.empty()) {
    SetProperty(
        env, exception, "stagePath", MakeWideString(env, error.stage_path));
  }
  napi_throw(env, exception);
  return nullptr;
}

napi_value ThrowInvalid(napi_env env, const std::string& message) {
  GuardError error;
  SetError(
      error,
      "INVALID_ARGUMENT",
      ERROR_INVALID_PARAMETER,
      "VALIDATE",
      message);
  return ThrowGuardError(env, error);
}

bool GetWideString(
    napi_env env,
    napi_value value,
    std::wstring& output,
    const char* field_name) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) {
    ThrowInvalid(env, std::string(field_name) + " must be a string");
    return false;
  }
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok ||
      length > kMaxStringChars) {
    ThrowInvalid(env, std::string(field_name) + " is invalid or too long");
    return false;
  }
  std::vector<char16_t> buffer(length + 1, 0);
  size_t copied = 0;
  if (napi_get_value_string_utf16(
          env, value, buffer.data(), buffer.size(), &copied) != napi_ok) {
    ThrowInvalid(env, std::string("Unable to decode ") + field_name);
    return false;
  }
  output.assign(reinterpret_cast<const wchar_t*>(buffer.data()), copied);
  if (output.empty() || output.find(L'\0') != std::wstring::npos) {
    ThrowInvalid(env, std::string(field_name) + " must be non-empty and NUL-free");
    return false;
  }
  return true;
}

bool GetUtf8String(
    napi_env env,
    napi_value value,
    std::string& output,
    const char* field_name) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) {
    ThrowInvalid(env, std::string(field_name) + " must be a string");
    return false;
  }
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok ||
      length > kMaxStringChars) {
    ThrowInvalid(env, std::string(field_name) + " is invalid or too long");
    return false;
  }
  std::vector<char> buffer(length + 1, 0);
  size_t copied = 0;
  if (napi_get_value_string_utf8(
          env, value, buffer.data(), buffer.size(), &copied) != napi_ok) {
    ThrowInvalid(env, std::string("Unable to decode ") + field_name);
    return false;
  }
  output.assign(buffer.data(), copied);
  if (output.empty() || output.find('\0') != std::string::npos) {
    ThrowInvalid(env, std::string(field_name) + " must be non-empty and NUL-free");
    return false;
  }
  return true;
}

bool GetBuffer(
    napi_env env,
    napi_value value,
    const uint8_t*& data,
    size_t& length) {
  bool is_buffer = false;
  if (napi_is_buffer(env, value, &is_buffer) != napi_ok || !is_buffer) {
    ThrowInvalid(env, "replacementBuffer must be a Buffer");
    return false;
  }
  void* raw = nullptr;
  if (napi_get_buffer_info(env, value, &raw, &length) != napi_ok ||
      length > kMaxMarkerBytes) {
    ThrowInvalid(env, "replacementBuffer is invalid or exceeds 16 MiB");
    return false;
  }
  data = static_cast<const uint8_t*>(raw);
  return true;
}

bool GetUint32(
    napi_env env,
    napi_value value,
    uint32_t& output,
    const char* field_name) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number) {
    ThrowInvalid(env, std::string(field_name) + " must be a uint32 number");
    return false;
  }
  double numeric = 0.0;
  if (napi_get_value_double(env, value, &numeric) != napi_ok ||
      !std::isfinite(numeric) || std::trunc(numeric) != numeric ||
      numeric < 0.0 || numeric > 4294967295.0) {
    ThrowInvalid(env, std::string(field_name) + " must be a uint32 integer");
    return false;
  }
  output = static_cast<uint32_t>(numeric);
  return true;
}

bool ParseBeginArguments(
    napi_env env,
    const napi_value* arguments,
    BeginRequest& request) {
  if (!GetWideString(
          env, arguments[0], request.target_path, "targetPath") ||
      !GetBuffer(
          env,
          arguments[1],
          request.replacement,
          request.replacement_length) ||
      !GetUtf8String(
          env,
          arguments[2],
          request.expected_current_sha256,
          "expectedCurrentSha256") ||
      !GetUint32(
          env,
          arguments[3],
          request.expected_current_identity.volume_serial_number,
          "expectedVolumeSerialNumber") ||
      !GetUint32(
          env,
          arguments[4],
          request.expected_current_identity.file_index_high,
          "expectedFileIndexHigh") ||
      !GetUint32(
          env,
          arguments[5],
          request.expected_current_identity.file_index_low,
          "expectedFileIndexLow")) {
    return false;
  }
  return true;
}

napi_value MakeBeginResult(napi_env env, const BeginResult& result) {
  napi_value object;
  napi_create_object(env, &object);
  SetProperty(
      env,
      object,
      "transactionId",
      MakeString(env, result.transaction_id));
  SetProperty(env, object, "outcome", MakeString(env, "SUCCESS"));
  SetProperty(env, object, "sha256", MakeString(env, result.sha256));
  SetProperty(
      env,
      object,
      "volumeSerialNumber",
      MakeUint32(env, result.identity.volume_serial_number));
  SetProperty(
      env,
      object,
      "fileIndexHigh",
      MakeUint32(env, result.identity.file_index_high));
  SetProperty(
      env,
      object,
      "fileIndexLow",
      MakeUint32(env, result.identity.file_index_low));
  SetProperty(
      env,
      object,
      "backupPath",
      MakeWideString(env, result.backup_path));
  SetProperty(
      env,
      object,
      "bytesWritten",
      MakeDouble(env, static_cast<double>(result.bytes_written)));
  return object;
}

napi_value BeginBinding(
    napi_env env,
    napi_callback_info info,
    bool test_mode) {
  napi_value arguments[8];
  size_t argument_count = 8;
  napi_value this_value;
  if (napi_get_cb_info(
          env,
          info,
          &argument_count,
          arguments,
          &this_value,
          nullptr) != napi_ok) {
    return ThrowInvalid(env, "Unable to read guarded marker arguments");
  }
  const size_t expected_count = test_mode ? 8 : 6;
  if (argument_count != expected_count) {
    return ThrowInvalid(
        env,
        test_mode
            ? "guardedMarkerCommitBeginTest requires exactly eight arguments"
            : "guardedMarkerCommitBegin requires exactly six arguments");
  }

  BeginRequest request;
  if (!ParseBeginArguments(env, arguments, request)) return nullptr;

#ifdef WINHELM_NATIVE_TEST_HOOKS
  TestControl control;
  const TestControl* control_pointer = nullptr;
  if (test_mode) {
    if (!GetUtf8String(
            env, arguments[6], control.barrier_phase, "barrierPhase") ||
        !GetUtf8String(
            env, arguments[7], control.crash_phase, "crashPhase")) {
      return nullptr;
    }
    const bool valid_barrier =
        control.barrier_phase == "-" || control.barrier_phase == "guard" ||
        control.barrier_phase == "retire" ||
        control.barrier_phase == "publish";
    const bool valid_crash =
        control.crash_phase == "-" ||
        control.crash_phase == "before-retire" ||
        control.crash_phase == "after-retire" ||
        control.crash_phase == "after-publish";
    if (!valid_barrier || !valid_crash) {
      return ThrowInvalid(env, "Unsupported guarded marker test phase");
    }
    control_pointer = &control;
  }
#else
  if (test_mode) {
    return ThrowInvalid(env, "Test hooks are unavailable in production");
  }
#endif

  BeginResult result;
  GuardError error;
  try {
    const bool succeeded = BeginCore(
        std::move(request),
        result,
        error
#ifdef WINHELM_NATIVE_TEST_HOOKS
        , control_pointer
#endif
        );
    if (!succeeded) return ThrowGuardError(env, error);
  } catch (const std::bad_alloc&) {
    SetError(
        error,
        "COMMIT_FAILED",
        ERROR_NOT_ENOUGH_MEMORY,
        "INTERNAL",
        "Guarded marker commit exhausted native memory");
    return ThrowGuardError(env, error);
  } catch (...) {
    SetError(
        error,
        "COMMIT_FAILED",
        ERROR_UNHANDLED_EXCEPTION,
        "INTERNAL",
        "Guarded marker commit encountered an unexpected native exception");
    return ThrowGuardError(env, error);
  }
  return MakeBeginResult(env, result);
}

}  // namespace

napi_value Begin(napi_env env, napi_callback_info info) {
  return BeginBinding(env, info, false);
}

napi_value Acknowledge(napi_env env, napi_callback_info info) {
  napi_value arguments[2];
  size_t argument_count = 2;
  napi_value this_value;
  if (napi_get_cb_info(
          env,
          info,
          &argument_count,
          arguments,
          &this_value,
          nullptr) != napi_ok ||
      argument_count != 1) {
    return ThrowInvalid(
        env,
        "guardedMarkerCommitAcknowledge requires exactly one transactionId");
  }
  std::string token;
  if (!GetUtf8String(env, arguments[0], token, "transactionId")) {
    return nullptr;
  }
  if (token.size() != kTransactionTokenBytes * 2 ||
      !NormalizeSha256(token)) {
    return ThrowInvalid(
        env,
        "transactionId must be an opaque 64-character hexadecimal token");
  }

  std::shared_ptr<TransactionState> state;
  {
    std::lock_guard<std::mutex> lock(g_transactions_mutex);
    const auto found = g_transactions.find(token);
    if (found == g_transactions.end() || !found->second->acknowledgeable) {
      GuardError error;
      SetError(
          error,
          "INVALID_ARGUMENT",
          ERROR_NOT_FOUND,
          "ACKNOWLEDGE",
          "The guarded marker transaction is unknown or already acknowledged");
      return ThrowGuardError(env, error);
    }
    state = std::move(found->second);
    g_transactions.erase(found);
  }
  state.reset();

  napi_value result;
  napi_create_object(env, &result);
  SetProperty(env, result, "acknowledged", MakeBoolean(env, true));
  return result;
}

#ifdef WINHELM_NATIVE_TEST_HOOKS
napi_value BeginTest(napi_env env, napi_callback_info info) {
  return BeginBinding(env, info, true);
}

napi_value AttemptDeleteDirectoryTest(
    napi_env env,
    napi_callback_info info) {
  napi_value arguments[2];
  size_t argument_count = 2;
  napi_value this_value;
  if (napi_get_cb_info(
          env,
          info,
          &argument_count,
          arguments,
          &this_value,
          nullptr) != napi_ok ||
      argument_count != 1) {
    return ThrowInvalid(
        env,
        "guardedMarkerAttemptDeleteDirectoryTest requires exactly one path");
  }
  std::wstring path;
  if (!GetWideString(env, arguments[0], path, "path")) return nullptr;

  DWORD native_error = ERROR_SUCCESS;
  bool succeeded = false;
  ScopedHandle directory(CreateFileW(
      path.c_str(),
      DELETE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr));
  if (!directory.valid()) {
    native_error = GetLastError();
  } else {
    FILE_DISPOSITION_INFO disposition{};
    disposition.DeleteFile = TRUE;
    succeeded = SetFileInformationByHandle(
                    directory.get(),
                    FileDispositionInfo,
                    &disposition,
                    sizeof(disposition)) != FALSE;
    if (!succeeded) native_error = GetLastError();
  }

  napi_value result;
  napi_create_object(env, &result);
  SetProperty(env, result, "succeeded", MakeBoolean(env, succeeded));
  SetProperty(env, result, "nativeCode", MakeUint32(env, native_error));
  return result;
}
#endif

}  // namespace winhelm::guarded_marker
