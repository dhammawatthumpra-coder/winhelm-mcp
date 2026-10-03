import { ConfigManager } from "./config-manager.js";
import {
  defaultAuthTokenPath,
  generateAuthToken,
  writeStoredAuthToken,
} from "./auth-token-store.js";

export interface AuthTokenRotationResult {
  token: string;
  storePath: string;
}

export interface AuthTokenRotationOptions {
  storePath?: string;
  manager?: ConfigManager;
}

/**
 * Rotate the MCP bearer token.
 *
 * Order matters: the new secret is persisted first, then applied to the running
 * server. A failed write leaves the previous token valid, so a rotation can
 * never lock the server out with a credential nobody holds.
 */
export async function rotateAuthToken(
  options: AuthTokenRotationOptions = {}
): Promise<AuthTokenRotationResult> {
  const manager = options.manager ?? ConfigManager.getInstance();
  const storePath = options.storePath ?? defaultAuthTokenPath();
  const token = generateAuthToken();

  await writeStoredAuthToken(token, storePath);
  manager.setRuntimeAuthToken(token);

  return { token, storePath };
}
