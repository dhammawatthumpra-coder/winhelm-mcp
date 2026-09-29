/**
 * Pure functions for validating server network exposure and interface binding security.
 */

/**
 * Check if the specified host is a local loopback address (IPv4 or IPv6).
 * Note: 0.0.0.0 and :: are INADDR_ANY (all interfaces) and are strictly NOT loopback.
 */
export function isLoopbackHost(host?: string | null): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  if (h === "localhost" || h === "::1" || h === "[::1]") {
    return true;
  }
  // IPv4 Loopback range: 127.0.0.0/8 (127.0.0.1 - 127.255.255.255)
  if (/^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(h)) {
    return true;
  }
  return false;
}

export interface NetworkExposureOptions {
  host: string;
  isStdio: boolean;
  authToken?: string | null;
}

export interface NetworkExposureResult {
  allowed: boolean;
  error?: string;
}

/**
 * Validate whether the server configuration is permitted to start based on network exposure.
 * Fails closed if non-stdio mode binds to a non-loopback interface without an authentication token.
 */
export function validateNetworkExposure(options: NetworkExposureOptions): NetworkExposureResult {
  // 1. stdio mode operates exclusively via stdin/stdout wire, no TCP network exposure
  if (options.isStdio) {
    return { allowed: true };
  }

  // 2. Loopback interfaces are restricted to localhost
  if (isLoopbackHost(options.host)) {
    return { allowed: true };
  }

  // 3. Non-loopback interface requires an authentication token
  const token = options.authToken?.trim();
  if (!token) {
    return {
      allowed: false,
      error: `Server cannot bind to non-loopback address "${options.host}" without an authentication token. Exposing WinHelm to a local or public network without authentication permits remote code execution. Provide --auth <token> or set MCP_AUTH_TOKEN in environment.`,
    };
  }

  return { allowed: true };
}
