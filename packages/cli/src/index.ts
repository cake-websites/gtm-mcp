#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createAuthFromEnv,
  createGtmMcpServer,
  GtmAccessPolicy,
  GTM_EDIT_SCOPES,
  resolveAuthMode,
  setLogSink,
} from "google-tag-manager-mcp-core";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";

// stdout carries the JSON-RPC stream, so every log line has to go to stderr.
setLogSink((message, ...rest) => console.error(message, ...rest));

// Cake fork: GTM_MODE=edit enables workspace edits for GTM_ACCOUNT_ALLOWLIST
// only, and every edit attempt is appended to GTM_AUDIT_LOG. Anything else is read-only.
function accessFromEnv(env: NodeJS.ProcessEnv): GtmAccessPolicy {
  if (!env.GTM_MODE || env.GTM_MODE === "read") return { mode: "read" };
  if (env.GTM_MODE !== "edit") {
    throw new Error(`GTM_MODE must be "read" or "edit", got "${env.GTM_MODE}"`);
  }

  const accountAllowlist = (env.GTM_ACCOUNT_ALLOWLIST ?? "")
    .split(/[\s,]+/)
    .filter(Boolean);
  const auditLog = env.GTM_AUDIT_LOG;
  if (accountAllowlist.length === 0 || !auditLog) {
    throw new Error(
      "GTM_MODE=edit requires GTM_ACCOUNT_ALLOWLIST and GTM_AUDIT_LOG.",
    );
  }

  return {
    mode: "edit",
    accountAllowlist,
    audit: (entry): void => {
      try {
        appendFileSync(auditLog, `${JSON.stringify(entry)}\n`);
      } catch (error) {
        console.error(`[${PACKAGE_NAME}] audit log write failed:`, error);
      }
    },
  };
}

async function main(): Promise<void> {
  const access = accessFromEnv(process.env);
  const authEnv =
    access.mode === "edit"
      ? { ...process.env, GTM_SCOPES: GTM_EDIT_SCOPES.join(" ") }
      : process.env;

  const server = createGtmMcpServer({
    auth: createAuthFromEnv(authEnv),
    serverInfo: { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    access,
  });

  await server.connect(new StdioServerTransport());

  console.error(
    `[${PACKAGE_NAME}] v${PACKAGE_VERSION} ready on stdio (auth: ${resolveAuthMode(process.env)}, mode: ${access.mode})`,
  );
}

main().catch((error: unknown) => {
  console.error(
    `[${PACKAGE_NAME}] failed to start:\n${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
