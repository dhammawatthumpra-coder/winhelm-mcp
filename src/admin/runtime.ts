import {
  AdminAuthManager,
  type AdminAuthOptions,
} from "./auth.js";

let manager = new AdminAuthManager();

export function getAdminAuthManager(): AdminAuthManager {
  return manager;
}

export function resetAdminAuthManager(
  options: AdminAuthOptions = {}
): AdminAuthManager {
  manager = new AdminAuthManager(options);
  return manager;
}
