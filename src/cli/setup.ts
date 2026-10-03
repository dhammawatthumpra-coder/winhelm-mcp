import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { ConfigManager } from "../config/config-manager.js";
import {
  applyLegacyMigrationApplication,
  applyProfilePreset,
  previewLegacyMigrationApplication,
  previewProfileApplication,
  ProfileServiceError,
  type ProfileApplyInput,
  type ProfileFolderSelection,
} from "../config/profile-service.js";
import type { ProfilePreset } from "../config/schema-v2.js";

const PRESETS = new Set<ProfilePreset>([
  "safe",
  "balanced",
  "power",
  "minimal",
  "core",
  "dev",
  "sysadmin",
  "full",
]);

export interface SetupCliResult {
  handled: boolean;
  exitCode: number;
  output?: string;
  error?: string;
}

export interface SetupCliIo {
  input?: Readable;
  output?: Writable;
  isInteractive?: boolean;
}

interface SetupArgs {
  configPath?: string;
  answersPath?: string;
  preset?: ProfilePreset;
  folders?: ProfileFolderSelection[];
  confirmation?: string;
  migrateLegacy: boolean;
  dryRun: boolean;
  yes: boolean;
}

function argValue(args: string[], flag: string): string | undefined {
  const exact = args.indexOf(flag);
  if (
    exact >= 0 &&
    args[exact + 1] &&
    !args[exact + 1].startsWith("-")
  ) {
    return args[exact + 1];
  }

  const prefixed = args.find((arg) => arg.startsWith(flag + "="));
  return prefixed?.slice(flag.length + 1);
}

function repeatedArgValues(args: string[], flag: string): string[] {
  const values: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      const value = args[i + 1];
      if (value && !value.startsWith("-")) {
        values.push(value);
        i += 1;
      }
      continue;
    }

    if (args[i].startsWith(flag + "=")) {
      values.push(args[i].slice(flag.length + 1));
    }
  }

  return values;
}

function parsePreset(value: unknown): ProfilePreset | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  return PRESETS.has(normalized as ProfilePreset)
    ? (normalized as ProfilePreset)
    : undefined;
}

function parseFolderSpec(value: string): ProfileFolderSelection {
  const trimmed = value.normalize("NFKC").trim();
  if (!trimmed) {
    throw new Error("Folder value must not be empty.");
  }

  // Optional display alias syntax: --folder "D:\Work::workspace"
  const marker = trimmed.lastIndexOf("::");
  if (marker > 1) {
    const folderPath = trimmed.slice(0, marker).trim();
    const alias = trimmed.slice(marker + 2).trim();
    if (folderPath && alias) return { path: folderPath, alias };
  }

  return { path: trimmed };
}

function parseCliArgs(args: string[]): SetupArgs {
  const presetRaw = argValue(args, "--preset");
  const preset = presetRaw ? parsePreset(presetRaw) : undefined;
  if (presetRaw && !preset) {
    throw new Error(
      "Unknown preset. Use safe, balanced, power, minimal, core, dev, sysadmin, or full."
    );
  }

  const folderValues = repeatedArgValues(args, "--folder");

  return {
    configPath: argValue(args, "--config"),
    answersPath: argValue(args, "--answers"),
    preset,
    folders:
      folderValues.length > 0
        ? folderValues.map(parseFolderSpec)
        : undefined,
    confirmation: argValue(args, "--confirm"),
    migrateLegacy: args.includes("--migrate-legacy"),
    dryRun: args.includes("--dry-run"),
    yes: args.includes("--yes") || args.includes("-y"),
  };
}

function normalizeAnswerFolders(value: unknown): ProfileFolderSelection[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("answers.folders must be an array.");
  }

  return value.map((item, index) => {
    if (typeof item === "string") return parseFolderSpec(item);
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`answers.folders[${index}] must be a string or object.`);
    }

    const raw = item as Record<string, unknown>;
    if (typeof raw.path !== "string" || !raw.path.trim()) {
      throw new Error(`answers.folders[${index}].path is required.`);
    }
    if (
      raw.alias !== undefined &&
      (typeof raw.alias !== "string" || !raw.alias.trim())
    ) {
      throw new Error(
        `answers.folders[${index}].alias must be a non-empty string.`
      );
    }

    return {
      path: raw.path,
      ...(typeof raw.alias === "string" ? { alias: raw.alias } : {}),
    };
  });
}

async function readAnswerFile(filePath: string): Promise<ProfileApplyInput> {
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) {
    throw new Error(`Answers file not found: ${resolved}`);
  }

  const parsed = JSON.parse(await fs.readFile(resolved, "utf8")) as Record<
    string,
    unknown
  >;
  const preset = parsePreset(parsed.preset);
  if (!preset) {
    throw new Error(
      "answers.preset must be safe, balanced, power, minimal, core, dev, sysadmin, or full."
    );
  }

  return {
    preset,
    ...(parsed.folders !== undefined
      ? { folders: normalizeAnswerFolders(parsed.folders) }
      : {}),
    ...(typeof parsed.confirmation === "string"
      ? { confirmation: parsed.confirmation }
      : {}),
  };
}

function currentSuggestedFolders(manager: ConfigManager): string {
  const config = manager.getConfig();

  if (
    manager.getConfigMode() === "v2" &&
    Array.isArray(config.folders) &&
    config.folders.length > 0
  ) {
    return config.folders.map((folder) => folder.path).join(",");
  }

  if (
    manager.getConfigMode() === "legacy" &&
    Array.isArray(config.allowedDirectories) &&
    config.allowedDirectories.length > 0 &&
    !config.allowedDirectories.some((entry) => {
      const value = entry.trim().toLowerCase();
      return value === "*" || value === "all";
    })
  ) {
    return config.allowedDirectories.join(",");
  }

  return "";
}

function formatMigrationPreview(
  proposal: ReturnType<typeof previewLegacyMigrationApplication>
): string {
  const lines = [
    "",
    "WinHelm legacy migration preview",
    "-------------------------------",
    `Status: ${proposal.status}`,
    `Source profile: ${proposal.sourceProfile ?? "n/a"}`,
    `Suggested preset: ${proposal.suggestedPreset ?? "manual/modified"}`,
  ];

  if (proposal.candidate) {
    const counts = { auto: 0, ask: 0, off: 0 };
    for (const value of Object.values(proposal.candidate.toolPolicy)) {
      if (value === "auto") counts.auto += 1;
      else if (value === "ask") counts.ask += 1;
      else if (value === "off") counts.off += 1;
    }

    lines.push(
      `Terminal: ${proposal.candidate.terminal.mode}`,
      `Folders: ${proposal.candidate.folders.length}`,
      `Tool policy: auto=${counts.auto}, ask=${counts.ask}, off=${counts.off}`
    );

    for (const folder of proposal.candidate.folders) {
      lines.push(
        `  - ${folder.path} [${folder.permission}]${folder.alias ? ` @${folder.alias}` : ""}`
      );
    }
  }

  for (const warning of proposal.warnings) {
    lines.push(`WARNING: ${warning}`);
  }
  for (const note of proposal.notes) {
    lines.push(`NOTE: ${note}`);
  }

  return lines.join("\n");
}

function formatPreview(
  preview: ReturnType<typeof previewProfileApplication>
): string {
  const policy = preview.toolPolicy;
  const counts = { auto: 0, ask: 0, off: 0 };
  for (const value of Object.values(policy)) {
    if (value === "auto") counts.auto += 1;
    else if (value === "ask") counts.ask += 1;
    else if (value === "off") counts.off += 1;
  }

  const lines = [
    "",
    "WinHelm setup preview",
    "---------------------",
    `Preset: ${preview.preset}`,
    `Terminal: ${preview.terminalMode}`,
    `Changed: ${preview.changedFields.length ? preview.changedFields.join(", ") : "none"}`,
    `Tool policy: auto=${counts.auto}, ask=${counts.ask}, off=${counts.off}`,
    "Folders:",
    ...(preview.folders.length
      ? preview.folders.map(
          (folder) =>
            `  - ${folder.path} [${folder.permission}]${folder.alias ? ` @${folder.alias}` : ""}`
        )
      : ["  - (none)"]),
  ];

  for (const warning of preview.warnings) {
    lines.push(`WARNING: ${warning}`);
  }
  if (preview.requiresTypedConfirmation) {
    lines.push(
      'WARNING: This preset enables terminal full. Local typed confirmation "confirm" is required.'
    );
  }

  return lines.join("\n");
}

async function interactiveInput(
  manager: ConfigManager,
  parsed: SetupArgs,
  io: SetupCliIo
): Promise<{ input: ProfileApplyInput; confirmed: boolean }> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const interactive =
    io.isInteractive ??
    (process.stdin.isTTY === true && process.stdout.isTTY === true);

  if (!interactive) {
    throw new Error(
      "Interactive setup requires a local TTY. Use --answers <file.json> for non-interactive setup."
    );
  }

  const rl = readline.createInterface({ input, output });
  try {
    const presetAnswer =
      parsed.preset ??
      parsePreset(
        (
          await rl.question(
            "Preset [safe/balanced/power/minimal/core/dev/sysadmin/full] (balanced): "
          )
        ).trim() || "balanced"
      );
    if (!presetAnswer) {
      throw new Error("Invalid preset.");
    }

    let folders = parsed.folders;
    if (!folders) {
      const suggested = currentSuggestedFolders(manager);
      const answer = await rl.question(
        `Folders (comma-separated paths)${suggested ? ` [${suggested}]` : ""}: `
      );
      const raw = answer.trim() || suggested;
      folders = raw
        ? raw
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
            .map(parseFolderSpec)
        : [];
    }

    let confirmation = parsed.confirmation;
    if (
      !confirmation &&
      (presetAnswer === "power" || presetAnswer === "full")
    ) {
      confirmation = await rl.question(
        'Type "confirm" to enable automatic terminal execution: '
      );
    }

    const profileInput: ProfileApplyInput = {
      preset: presetAnswer,
      folders,
      ...(confirmation ? { confirmation } : {}),
    };

    const preview = previewProfileApplication(profileInput, manager);
    output.write(formatPreview(preview) + "\n");

    if (parsed.dryRun) {
      return { input: profileInput, confirmed: false };
    }

    if (parsed.yes) {
      return { input: profileInput, confirmed: true };
    }

    const apply = (
      await rl.question("Apply this configuration? [y/N]: ")
    )
      .trim()
      .toLowerCase();

    return {
      input: profileInput,
      confirmed: apply === "y" || apply === "yes",
    };
  } finally {
    rl.close();
  }
}

export async function runSetupCliCommand(
  args: string[],
  io: SetupCliIo = {}
): Promise<SetupCliResult> {
  if (args[0] !== "setup") {
    return { handled: false, exitCode: 0 };
  }

  try {
    const parsed = parseCliArgs(args.slice(1));
    const manager = ConfigManager.getInstance(parsed.configPath);
    await manager.init(parsed.configPath);

    if (parsed.migrateLegacy) {
      if (
        parsed.answersPath ||
        parsed.preset ||
        parsed.confirmation
      ) {
        throw new Error(
          "--migrate-legacy cannot be combined with --answers, --preset, or --confirm."
        );
      }

      const migrationInput = parsed.folders
        ? { folders: parsed.folders }
        : {};
      const proposal = previewLegacyMigrationApplication(
        migrationInput,
        manager
      );
      const previewText = formatMigrationPreview(proposal);

      if (parsed.dryRun) {
        return {
          handled: true,
          exitCode: 0,
          output:
            previewText +
            "\nDry run only; no configuration was changed.",
        };
      }

      if (proposal.status !== "ready") {
        return {
          handled: true,
          exitCode: 2,
          output: previewText,
          error:
            proposal.status === "folder-selection-required"
              ? "Legacy wildcard access requires one or more explicit --folder values."
              : "This config is not eligible for legacy migration.",
        };
      }

      if (!parsed.yes) {
        return {
          handled: true,
          exitCode: 2,
          output: previewText,
          error:
            "Legacy migration requires --yes to persist changes (or use --dry-run).",
        };
      }

      const migrated = await applyLegacyMigrationApplication(
        migrationInput,
        manager
      );
      return {
        handled: true,
        exitCode: 0,
        output: [
          "WinHelm legacy migration complete.",
          "Preset: " + (migrated.status.preset ?? "manual/modified"),
          "Terminal: " + (migrated.status.terminalMode ?? "off"),
          "Folders: " + migrated.status.folders.length,
          "Modified: " +
            (migrated.status.modified === true
              ? "yes"
              : migrated.status.modified === false
                ? "no"
                : "n/a"),
          ...(migrated.backupPath
            ? ["Backup: " + migrated.backupPath]
            : []),
          "Restart/reconnect the MCP client if it cached the previous tool list.",
        ].join("\n"),
      };
    }

    let profileInput: ProfileApplyInput;
    let confirmed = true;

    if (parsed.answersPath) {
      const answerInput = await readAnswerFile(parsed.answersPath);
      profileInput = {
        ...answerInput,
        ...(parsed.preset ? { preset: parsed.preset } : {}),
        ...(parsed.folders ? { folders: parsed.folders } : {}),
        ...(parsed.confirmation
          ? { confirmation: parsed.confirmation }
          : {}),
      };
      const preview = previewProfileApplication(profileInput, manager);
      const previewText = formatPreview(preview);

      if (parsed.dryRun) {
        return {
          handled: true,
          exitCode: 0,
          output: previewText + "\nDry run only; no configuration was changed.",
        };
      }

      if (!parsed.yes) {
        return {
          handled: true,
          exitCode: 2,
          output: previewText,
          error:
            "Non-interactive setup requires --yes to persist changes (or use --dry-run).",
        };
      }
    } else {
      const interactive = await interactiveInput(manager, parsed, io);
      profileInput = interactive.input;
      confirmed = interactive.confirmed;

      if (parsed.dryRun) {
        const preview = previewProfileApplication(profileInput, manager);
        return {
          handled: true,
          exitCode: 0,
          output:
            formatPreview(preview) +
            "\nDry run only; no configuration was changed.",
        };
      }

      if (!confirmed) {
        return {
          handled: true,
          exitCode: 0,
          output: "Setup cancelled; configuration was not changed.",
        };
      }
    }

    const result = await applyProfilePreset(profileInput, manager);
    const status = result.status;

    return {
      handled: true,
      exitCode: 0,
      output: [
        "WinHelm setup complete.",
        `Preset: ${status.preset ?? "modified"}`,
        `Terminal: ${status.terminalMode ?? "off"}`,
        `Folders: ${status.folders.length}`,
        `Modified: ${status.modified === true ? "yes" : "no"}`,
        ...(result.backupPath
          ? [`Backup: ${result.backupPath}`]
          : []),
        "Restart/reconnect the MCP client if it cached the previous tool list.",
      ].join("\n"),
    };
  } catch (err) {
    const message =
      err instanceof ProfileServiceError
        ? `${err.code}: ${err.message}`
        : (err as Error).message || String(err);

    return {
      handled: true,
      exitCode: 1,
      error: message,
    };
  }
}
