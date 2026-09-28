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

type ToolArgs = [
  string,
  string,
  Record<string, z.ZodType>,
  (args: Record<string, unknown>, extra: unknown) => unknown,
];

/** Wraps `server` so tool registrations are filtered through READ_ONLY_ACTIONS. */
export function readOnlyServer(server: McpServer): McpServer {
  // server.tool's overloads are typed per schema; this filter is schema-agnostic.
  const register = server.tool.bind(server) as unknown as (
    ...args: ToolArgs
  ) => unknown;

  const tool = (...args: unknown[]): unknown => {
    if (args.length !== 4) {
      throw new Error(
        `read-only filter expects server.tool(name, description, schema, handler), got ${args.length} arguments`,
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

    const actions = allowed as [string, ...string[]];

    return register(
      name,
      `${description} Read-only server: only ${actions.join(", ")} are available.`,
      {
        ...schema,
        action: z
          .enum(actions)
          .describe(
            `The operation to perform. Must be one of: ${actions.map((a) => `'${a}'`).join(", ")}.`,
          ),
      },
      (toolArgs, extra) =>
        actions.includes(toolArgs.action as string)
          ? handler(toolArgs, extra)
          : createErrorResponse(
              `${name} action '${String(toolArgs.action)}' is disabled on this read-only server`,
              "read-only",
            ),
    );
  };

  return new Proxy(server, {
    get: (target, prop, receiver) =>
      prop === "tool" ? tool : Reflect.get(target, prop, receiver),
  });
}
