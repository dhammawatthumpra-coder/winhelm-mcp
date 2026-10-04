export type AdminMandatoryConfirmationClass =
  | "authority-expansion"
  | "credential-security-mutation"
  | "network-exposure-expansion"
  | "approval-prompt-reduction";

/**
 * These classes are product security-floor mutations. They require explicit
 * local confirmation regardless of the active Approval Mode.
 */
export function adminMutationRequiresMandatoryConfirmation(
  kind: AdminMandatoryConfirmationClass
): boolean {
  switch (kind) {
    case "authority-expansion":
    case "credential-security-mutation":
    case "network-exposure-expansion":
    case "approval-prompt-reduction":
      return true;
  }
}

export function isValidLocalConfirmation(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  return normalized === "confirm" || normalized === "ยืนยัน";
}
