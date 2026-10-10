/**
 * WinHelm Trusted Durable Principal Propagation Boundary
 *
 * Distinguishes durable connector/principal identity from ephemeral MCP transport session leases.
 * Validated cryptographically via HMAC-SHA256 using the Core auth token as the shared secret.
 *
 * Guarantees:
 * - Public clients cannot forge the principal (they lack the Core auth token).
 * - Public Ingress strictly sets the principal from authenticated connector alias records.
 * - Direct local clients without trusted binding fail closed to transport session isolation.
 * - Plaintext connector tokens are rejected; only stable opaque identifiers/fingerprints are allowed.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const HEADER_DURABLE_PRINCIPAL = "x-winhelm-durable-principal";
export const HEADER_DURABLE_PRINCIPAL_SIG = "x-winhelm-durable-principal-sig";

const HMAC_MESSAGE_PREFIX = "winhelm-durable-principal:";
const PRINCIPAL_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const PLAINTEXT_TOKEN_PATTERN = /^whc_[A-Za-z0-9_-]{43}$/;

export interface TrustedPrincipalSuccess {
  ok: true;
  principalId: string;
}

export interface TrustedPrincipalFailure {
  ok: false;
  reason:
    | "NO_AUTH_TOKEN"
    | "NO_PRINCIPAL_HEADER"
    | "MISSING_SIGNATURE"
    | "MALFORMED_PRINCIPAL"
    | "PLAINTEXT_TOKEN_FORBIDDEN"
    | "INVALID_SIGNATURE";
}

export type TrustedPrincipalExtraction =
  | TrustedPrincipalSuccess
  | TrustedPrincipalFailure;

export function computePrincipalSignature(
  principalId: string,
  authToken: string
): string {
  return createHmac("sha256", authToken)
    .update(`${HMAC_MESSAGE_PREFIX}${principalId}`, "utf8")
    .digest("hex");
}

export function createTrustedPrincipalHeaders(
  principalId: string,
  authToken: string
): Record<string, string> {
  const signature = computePrincipalSignature(principalId, authToken);
  return {
    [HEADER_DURABLE_PRINCIPAL]: principalId,
    [HEADER_DURABLE_PRINCIPAL_SIG]: signature,
  };
}

export function extractTrustedPrincipal(
  headers: Record<string, string | string[] | undefined>,
  authToken: string | undefined
): TrustedPrincipalExtraction {
  if (!authToken || typeof authToken !== "string" || authToken.trim() === "") {
    return { ok: false, reason: "NO_AUTH_TOKEN" };
  }

  const rawPrincipal = headers[HEADER_DURABLE_PRINCIPAL];
  const principal =
    typeof rawPrincipal === "string"
      ? rawPrincipal.trim()
      : Array.isArray(rawPrincipal) && typeof rawPrincipal[0] === "string"
      ? rawPrincipal[0].trim()
      : undefined;

  if (!principal) {
    return { ok: false, reason: "NO_PRINCIPAL_HEADER" };
  }

  if (PLAINTEXT_TOKEN_PATTERN.test(principal)) {
    return { ok: false, reason: "PLAINTEXT_TOKEN_FORBIDDEN" };
  }

  if (!PRINCIPAL_ID_PATTERN.test(principal)) {
    return { ok: false, reason: "MALFORMED_PRINCIPAL" };
  }

  const rawSig = headers[HEADER_DURABLE_PRINCIPAL_SIG];
  const sig =
    typeof rawSig === "string"
      ? rawSig.trim()
      : Array.isArray(rawSig) && typeof rawSig[0] === "string"
      ? rawSig[0].trim()
      : undefined;

  if (!sig || !/^[0-9a-fA-F]{64}$/.test(sig)) {
    return { ok: false, reason: "MISSING_SIGNATURE" };
  }

  const expectedSig = computePrincipalSignature(principal, authToken);
  const sigBuf = Buffer.from(sig.toLowerCase(), "hex");
  const expBuf = Buffer.from(expectedSig.toLowerCase(), "hex");

  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, reason: "INVALID_SIGNATURE" };
  }

  return { ok: true, principalId: principal };
}
