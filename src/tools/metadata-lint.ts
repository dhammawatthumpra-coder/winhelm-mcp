/**
 * Tool-surface lint helpers (baseline 5.2).
 *
 * `validateToolMetadataRegistry` in metadata.ts covers titles, descriptions and
 * annotations from the central registry. Parameter descriptions only exist on
 * the registered zod schemas, so they are checked here against the live tool
 * registration.
 */

export interface RegisteredToolLike {
  inputSchema?: {
    shape?: Record<string, unknown>;
  };
}

function parameterDescription(schema: unknown): string | undefined {
  let current: any = schema;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    const description = current?._def?.description;
    if (typeof description === "string" && description.trim()) {
      return description;
    }
    current = current?._def?.innerType ?? current?._def?.schema;
  }
  return undefined;
}

export function collectParameterDescriptionIssues(
  registeredTools: Record<string, RegisteredToolLike>
): string[] {
  const issues: string[] = [];

  for (const [name, tool] of Object.entries(registeredTools)) {
    const shape = tool?.inputSchema?.shape;
    if (!shape) {
      issues.push(`missing input schema: ${name}`);
      continue;
    }

    for (const [field, schema] of Object.entries(shape)) {
      if (!parameterDescription(schema)) {
        issues.push(`missing parameter description: ${name}.${field}`);
      }
    }
  }

  return issues;
}
