/**
 * Internal-only guarded commit wrapper for the active-backend marker.
 *
 * This module deliberately is not registered as an MCP tool. Destructive
 * authority must be supplied explicitly as the expected SHA-256 and Windows
 * file identity; this wrapper never snapshots the current path to authorize a
 * commit or rollback.
 */
import path from "node:path";
import { TextDecoder } from "node:util";
import { getNativeBoundary } from "../native/boundary.js";
import type {
  GuardedMarkerCommitResult,
  GuardedMarkerFileIdentity,
} from "../../native/index.js";

const ACTIVE_BACKEND_MARKER_NAME = "winhelm.active-backend.json";
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const MAX_MARKER_BYTES = 16 * 1024 * 1024;

export interface ExpectedActiveBackendMarkerAuthority
  extends GuardedMarkerFileIdentity {
  sha256: string;
}

export interface GuardedActiveBackendMarkerCommitRequest {
  markerPath: string;
  replacementJson: string | Buffer;
  expectedCurrent: ExpectedActiveBackendMarkerAuthority;
}

export interface GuardedActiveBackendMarkerCommit
  extends GuardedMarkerCommitResult {}

export class GuardedMarkerCommitValidationError extends Error {
  readonly code = "INVALID_ARGUMENT";
  readonly nativeCode = 87;

  constructor(message: string) {
    super(message);
    this.name = "GuardedMarkerCommitValidationError";
  }
}

function invalid(message: string): never {
  throw new GuardedMarkerCommitValidationError(message);
}

function isUint32(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0xffff_ffff
  );
}

function requireAbsoluteWindowsPath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() !== value || !value) {
    invalid(`${field} must be a non-empty, trimmed string.`);
  }
  if (!path.win32.isAbsolute(value)) {
    invalid(`${field} must be an absolute Windows path.`);
  }
  return value;
}

function validateMarkerPath(markerPath: unknown): string {
  const value = requireAbsoluteWindowsPath(markerPath, "markerPath");
  if (
    path.win32.basename(value).toLowerCase() !==
    ACTIVE_BACKEND_MARKER_NAME
  ) {
    invalid(
      `markerPath must name the internal ${ACTIVE_BACKEND_MARKER_NAME} marker.`,
    );
  }
  return value;
}

function validateReplacement(replacementJson: string | Buffer): Buffer {
  if (typeof replacementJson !== "string" && !Buffer.isBuffer(replacementJson)) {
    invalid("replacementJson must be a string or Buffer.");
  }
  const bytes = Buffer.isBuffer(replacementJson)
    ? Buffer.from(replacementJson)
    : Buffer.from(replacementJson, "utf8");
  if (bytes.length > MAX_MARKER_BYTES) {
    invalid("replacementJson exceeds the 16 MiB marker limit.");
  }

  let value: unknown;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(json);
  } catch {
    invalid("replacementJson must contain valid UTF-8 JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("replacementJson must contain a JSON object.");
  }
  const marker = value as Record<string, unknown>;
  if (marker.schemaVersion !== 1) {
    invalid("replacementJson.schemaVersion must equal 1.");
  }
  requireAbsoluteWindowsPath(marker.backendRoot, "replacementJson.backendRoot");
  requireAbsoluteWindowsPath(marker.configPath, "replacementJson.configPath");
  if (
    typeof marker.expectedHead !== "string" ||
    !GIT_OBJECT_ID_PATTERN.test(marker.expectedHead)
  ) {
    invalid(
      "replacementJson.expectedHead must be a 40- or 64-character hexadecimal Git object id.",
    );
  }
  return bytes;
}

function validateAuthority(
  authority: ExpectedActiveBackendMarkerAuthority,
): ExpectedActiveBackendMarkerAuthority {
  if (!authority || typeof authority !== "object") {
    invalid("expectedCurrent must be an explicit authority object.");
  }
  if (typeof authority.sha256 !== "string" || !SHA256_PATTERN.test(authority.sha256)) {
    invalid("expectedCurrent.sha256 must be exactly 64 hexadecimal characters.");
  }
  for (const [field, value] of [
    ["volumeSerialNumber", authority.volumeSerialNumber],
    ["fileIndexHigh", authority.fileIndexHigh],
    ["fileIndexLow", authority.fileIndexLow],
  ] as const) {
    if (!isUint32(value)) {
      invalid(`expectedCurrent.${field} must be a uint32 integer.`);
    }
  }
  return {
    sha256: authority.sha256.toLowerCase(),
    volumeSerialNumber: authority.volumeSerialNumber,
    fileIndexHigh: authority.fileIndexHigh,
    fileIndexLow: authority.fileIndexLow,
  };
}

/**
 * Publish and prove an active-backend marker replacement, returning only after
 * native protection has been retained under an opaque transaction token.
 */
export function guardedActiveBackendMarkerCommitBegin(
  request: GuardedActiveBackendMarkerCommitRequest,
): GuardedActiveBackendMarkerCommit {
  if (!request || typeof request !== "object") {
    invalid("A guarded active-backend marker request is required.");
  }
  const markerPath = validateMarkerPath(request.markerPath);
  const replacement = validateReplacement(request.replacementJson);
  const expected = validateAuthority(request.expectedCurrent);
  return getNativeBoundary().guardedMarkerCommitBegin(
    markerPath,
    replacement,
    expected.sha256,
    expected.volumeSerialNumber,
    expected.fileIndexHigh,
    expected.fileIndexLow,
  );
}

/** Explicit normal finalization. Unknown and duplicate tokens fail closed. */
export function guardedActiveBackendMarkerCommitAcknowledge(
  transactionId: string,
): { acknowledged: true } {
  if (
    typeof transactionId !== "string" ||
    !SHA256_PATTERN.test(transactionId)
  ) {
    invalid("transactionId must be an opaque 64-character hexadecimal token.");
  }
  return getNativeBoundary().guardedMarkerCommitAcknowledge(transactionId);
}
