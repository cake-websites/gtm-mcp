import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createErrorResponse } from "./utils/index.js";

/**
 * Cake fork: the only tools and actions this server exposes. Anything not
 * listed here - a tool or an action - is never registered, so an upstream merge
 * that adds a write path stays hidden until someone allows it here.
 *
 * `null` marks a tool without an `action` parameter.
 */
export const READ_ONLY_ACTIONS: Record<string, readonly string[] | null> = {
  gtm_account: ["get", "list"],
  gtm_built_in_variable: ["list"],
  gtm_client: ["get", "list"],
  gtm_container: ["get", "list", "lookup", "snippet"],
  gtag_destination: null,
  gtm_environment: ["get", "list"],
  gtm_folder: ["get", "list", "entities"],
  gtm_gtag_config: ["get", "list"],
  gtm_tag: ["get", "list"],
  gtm_template: ["get", "list"],
  gtm_transformation: ["get", "list"],
  gtm_trigger: ["get", "list"],
  gtm_variable: ["get", "list"],
  gtm_version_header: ["list", "latest"],
  gtm_version: ["get", "live"],
  gtm_workspace: ["get", "list", "getStatus"],
  gtm_zone: ["get", "list"],
};

/**
 * Cake fork: workspace edits added in edit mode. Nothing here publishes,
 * deletes, creates versions, or touches permissions - publishing stays a human
 * step in the GTM UI. `revert` only discards unpublished workspace changes.
 */
export const EDIT_ACTIONS: Record<string, readonly string[]> = {
  gtm_built_in_variable: ["create", "revert"],
  gtm_tag: ["create", "update", "revert"],
  gtm_trigger: ["create", "update", "revert"],
  gtm_variable: ["create", "update", "revert"],
};

export type GtmAuditEntry = {
  ts: string;
  tool: string;
  action: string;
  ids: Record<string, string>;
  result: "ok" | "error" | "refused";
};

export type GtmAccessPolicy =
  | { mode: "read" }
  | {
      mode: "edit";
      /** GTM account IDs edits may target. Required and non-empty. */
      accountAllowlist: string[];
      audit?: (entry: GtmAuditEntry) => void;
    };

type ToolArgs = [
  string,
  string,
  Record<string, z.ZodType>,
  (args: Record<string, unknown>, extra: unknown) => unknown,
];

function idsOf(args: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(args).filter(
      ([key, value]) => key.endsWith("Id") && typeof value === "string",
    ),
  ) as Record<string, string>;
}

/** IDs Google returned for the entity - e.g. the tagId of a tag just created. */
function createdIds(result: {
  isError?: boolean;
  content?: { text?: string }[];
}): Record<string, string> {
  if (result?.isError) return {};
  try {
    return idsOf(JSON.parse(result?.content?.[0]?.text ?? ""));
  } catch {
    return {};
  }
}

/** Wraps `server` so tool registrations are filtered through the action allowlists. */
export function accessControlledServer(
  server: McpServer,
  policy: GtmAccessPolicy = { mode: "read" },
): McpServer {
  const edit = policy.mode === "edit" ? policy : undefined;
  if (edit && edit.accountAllowlist.length === 0) {
    throw new Error("edit mode requires a non-empty GTM account allowlist");
  }

  // server.tool's overloads are typed per schema; this filter is schema-agnostic.
  const register = server.tool.bind(server) as unknown as (
    ...args: ToolArgs
  ) => unknown;

  const tool = (...args: unknown[]): unknown => {
    if (args.length !== 4) {
      throw new Error(
        `access filter expects server.tool(name, description, schema, handler), got ${args.length} arguments`,
      );
    }

    const [name, description, schema, handler] = args as ToolArgs;
    const allowed = READ_ONLY_ACTIONS[name];

    if (allowed === undefined) return;
    if (allowed === null) {
      if ("action" in schema) {
        throw new Error(`${name} has an action parameter but no allowlist`);
      }
      return register(name, description, schema, handler);
    }

    const writes = edit ? (EDIT_ACTIONS[name] ?? []) : [];
    const actions = [...allowed, ...writes] as [string, ...string[]];
    const note = edit
      ? `Edit server: only ${actions.join(", ")} are available. Edits land in the workspace; publishing happens in the GTM UI.`
      : `Read-only server: only ${actions.join(", ")} are available.`;

    const guarded = async (
      toolArgs: Record<string, unknown>,
      extra: unknown,
    ): Promise<unknown> => {
      const action = String(toolArgs.action);
      if (!actions.includes(action)) {
        return createErrorResponse(
          `${name} action '${action}' is disabled on this server`,
          "access",
        );
      }
      if (!edit || !writes.includes(action)) return handler(toolArgs, extra);

      const entry = {
        ts: new Date().toISOString(),
        tool: name,
        action,
        ids: idsOf(toolArgs),
      };
      if (!edit.accountAllowlist.includes(String(toolArgs.accountId))) {
        edit.audit?.({ ...entry, result: "refused" });
        return createErrorResponse(
          `${name} ${action} refused: GTM account ${String(toolArgs.accountId)} is not in this server's allowlist`,
          "access",
        );
      }

      const result = (await handler(toolArgs, extra)) as {
        isError?: boolean;
        content?: { text?: string }[];
      };
      edit.audit?.({
        ...entry,
        ids: { ...createdIds(result), ...entry.ids },
        result: result?.isError ? "error" : "ok",
      });
      return result;
    };

    return register(
      name,
      `${description} ${note}`,
      {
        ...schema,
        action: z
          .enum(actions)
          .describe(
            `The operation to perform. Must be one of: ${actions.map((a) => `'${a}'`).join(", ")}.`,
          ),
      },
      guarded,
    );
  };

  // Only server.tool() is filtered. registerTool() would bypass the allowlists,
  // so it fails closed: an upstream move to it must extend this filter first.
  const registerTool = (name: unknown): never => {
    throw new Error(
      `${String(name)} uses registerTool(), which the access filter does not cover - extend accessControlledServer before registering it`,
    );
  };

  return new Proxy(server, {
    get: (target, prop, receiver): unknown => {
      if (prop === "tool") return tool;
      if (prop === "registerTool") return registerTool;
      return Reflect.get(target, prop, receiver);
    },
  });
}
