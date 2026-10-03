import type { Request } from "express";

function stripIpv6Brackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  let value = address.trim().toLowerCase();
  const zoneIndex = value.indexOf("%");
  if (zoneIndex >= 0) value = value.slice(0, zoneIndex);

  if (value === "::1") return true;
  if (value.startsWith("::ffff:")) {
    value = value.slice("::ffff:".length);
  }

  const match = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  return (
    octets.every((part) => part >= 0 && part <= 255) &&
    octets[0] === 127
  );
}

export function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;

  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    if (close < 0) return false;
    return isLoopbackAddress(stripIpv6Brackets(trimmed.slice(0, close + 1)));
  }

  const hostname = trimmed.split(":")[0];
  return hostname === "localhost" || isLoopbackAddress(hostname);
}

export function isLoopbackOrigin(
  origin: string | undefined,
  expectedPort?: number
): boolean {
  if (!origin) return false;

  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;

    const hostname = stripIpv6Brackets(url.hostname.toLowerCase());
    if (hostname !== "localhost" && !isLoopbackAddress(hostname)) return false;

    if (expectedPort !== undefined) {
      const port = url.port
        ? Number(url.port)
        : url.protocol === "https:"
          ? 443
          : 80;
      if (port !== expectedPort) return false;
    }

    return true;
  } catch {
    return false;
  }
}

export interface AdminRequestLocality {
  allowed: boolean;
  code?: "ADMIN_REMOTE_BLOCKED" | "ADMIN_HOST_BLOCKED";
  reason?: string;
}

export function validateAdminLocality(req: Request): AdminRequestLocality {
  const remoteAddress =
    req.socket?.remoteAddress ??
    (typeof req.ip === "string" ? req.ip : undefined);

  if (!isLoopbackAddress(remoteAddress)) {
    return {
      allowed: false,
      code: "ADMIN_REMOTE_BLOCKED",
      reason: "Admin plane is available only from a loopback connection.",
    };
  }

  if (!isLoopbackHostHeader(req.get("host") ?? undefined)) {
    return {
      allowed: false,
      code: "ADMIN_HOST_BLOCKED",
      reason: "Admin plane requires a loopback Host header.",
    };
  }

  return { allowed: true };
}
