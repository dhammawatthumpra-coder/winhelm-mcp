import { getToolRiskPresentation, type ToolRiskPresentation } from "../permissions/risk.js";
import { getToolRiskClass } from "../permissions/risk.js";
import type { ApprovalJob } from "./approval-engine.js";

export interface SanitizedApprovalSummary {
  jobId: string;
  tool: string;
  title: string;
  body: string;
  target?: string;
  riskPresentation: ToolRiskPresentation;
  isMandatoryConfirmation: boolean;
  clientName?: string | null;
}

const SENSITIVE_KEY_PATTERN = /(?:password|token|secret|auth|bearer|key|credential|private)/i;

/**
 * Sanitize a target string (path, command, url) so sensitive data, query params,
 * or unbounded lengths do not leak into desktop notifications or Action Center.
 */
export function sanitizeTargetSummary(
  tool: string,
  args: Record<string, unknown> = {}
): string | undefined {
  if (!args || typeof args !== "object") return undefined;

  // 1. Filesystem paths
  if (typeof args.path === "string" && args.path.trim().length > 0) {
    const raw = args.path.trim();
    return raw.length > 70 ? raw.slice(0, 32) + "..." + raw.slice(-35) : raw;
  }
  if (typeof args.source === "string" && typeof args.destination === "string") {
    const s = args.source.slice(0, 30);
    const d = args.destination.slice(0, 30);
    return `${s} -> ${d}`;
  }

  // 2. URLs (strip query string and userinfo)
  if (typeof args.url === "string" && args.url.trim().length > 0) {
    try {
      const parsed = new URL(args.url.trim());
      parsed.search = "";
      parsed.hash = "";
      parsed.username = "";
      parsed.password = "";
      const cleaned = parsed.toString().replace(/\/$/, "");
      return cleaned.length > 70 ? cleaned.slice(0, 67) + "..." : cleaned;
    } catch {
      return args.url.split("?")[0].slice(0, 70);
    }
  }

  // 3. Process / Service names
  if (typeof args.serviceName === "string" && args.serviceName.trim().length > 0) {
    return `Service: ${args.serviceName.trim().slice(0, 50)}`;
  }
  if (typeof args.processName === "string" && args.processName.trim().length > 0) {
    return `Process: ${args.processName.trim().slice(0, 50)}`;
  }
  if (typeof args.processId === "number" || typeof args.pid === "number") {
    const pid = args.processId ?? args.pid;
    return `PID: ${pid}`;
  }

  // 4. Registry keys
  if (typeof args.keyPath === "string" && args.keyPath.trim().length > 0) {
    const raw = args.keyPath.trim();
    return raw.length > 70 ? raw.slice(0, 32) + "..." + raw.slice(-35) : raw;
  }

  // 5. Commands (safe first-line extraction, strip potential secret flags)
  if (typeof args.command === "string" && args.command.trim().length > 0) {
    const firstLine = args.command.trim().split(/[\r\n]+/)[0] || "";
    // If command looks like it passes a secret flag, omit or truncate safely
    const words = firstLine.split(/\s+/);
    const safeWords: string[] = [];
    for (let i = 0; i < words.length && safeWords.length < 5; i++) {
      const w = words[i];
      if (SENSITIVE_KEY_PATTERN.test(w)) {
        safeWords.push("[REDACTED]");
        break;
      }
      safeWords.push(w);
    }
    const safeCmd = safeWords.join(" ");
    return safeCmd.length > 60 ? safeCmd.slice(0, 57) + "..." : safeCmd;
  }

  return undefined;
}

/**
 * Formats a bounded, safe, and descriptive summary of an approval job
 * suitable for Windows native notifications without leaking sensitive arguments.
 */
export function formatSanitizedApprovalSummary(
  job: Pick<ApprovalJob, "id" | "tool" | "args">,
  meta?: Record<string, unknown>
): SanitizedApprovalSummary {
  const tool = job.tool || "unknown_tool";
  const riskPresentation = getToolRiskPresentation(tool);
  const riskClass = getToolRiskClass(tool);

  // Check mandatory confirmation
  const isMandatoryConfirmation = Boolean(
    meta?.isMandatoryConfirmation ||
    riskClass === "R4" ||
    (tool === "process_kill" && meta?.mandatoryReason)
  );

  const clientName =
    typeof meta?.clientName === "string"
      ? meta.clientName
      : meta?.clientInfo && typeof (meta.clientInfo as any).name === "string"
        ? (meta.clientInfo as any).name
        : null;

  const target = sanitizeTargetSummary(tool, job.args ?? {});

  // Build title (max 64 chars)
  let title: string;
  if (isMandatoryConfirmation) {
    title = `[MANDATORY] Approval: ${tool}`;
  } else {
    title = `WinHelm Approval: ${tool}`;
  }
  if (title.length > 64) {
    title = title.slice(0, 61) + "...";
  }

  // Build body (max 256 chars)
  const lines: string[] = [];
  if (target) {
    lines.push(`Target: ${target}`);
  }
  const riskBadge = `${riskPresentation.level.toUpperCase()} (${riskPresentation.label})`;
  lines.push(`Risk: ${riskBadge}`);

  if (clientName) {
    lines.push(`Client: ${clientName}`);
  }

  if (isMandatoryConfirmation) {
    lines.push("Requires explicit confirmation.");
  }

  let body = lines.join("\n");
  if (body.length > 256) {
    body = body.slice(0, 253) + "...";
  }

  return {
    jobId: job.id,
    tool,
    title,
    body,
    target,
    riskPresentation,
    isMandatoryConfirmation,
    clientName,
  };
}
