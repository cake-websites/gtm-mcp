import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const CLI = "packages/cli/dist/index.js";
const TIMEOUT_MS = 30_000;

function run(env, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [CLI], {
      env: { ...env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${CLI} did not exit within ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    // "close", not "exit": only then is stdout drained.
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    child.stdin.end(stdin);
  });
}

function withoutGoogleCredentials() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GOOGLE_")),
  );
}

const requests = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
];

// No tool is called, so the token never reaches Google.
const served = await run(
  { ...process.env, GOOGLE_ACCESS_TOKEN: "smoke-test-token" },
  requests.map((request) => `${JSON.stringify(request)}\n`).join(""),
);

assert.equal(
  served.code,
  0,
  `CLI exited with ${served.code}\n${served.stderr}`,
);

const lines = served.stdout.trim().split("\n");
let messages;
try {
  messages = lines.map((line) => JSON.parse(line));
} catch (error) {
  // A log line on stdout corrupts the JSON-RPC stream - that is the failure.
  assert.fail(`stdout is not pure JSON-RPC:\n${served.stdout}\n${error}`);
}

const initialized = messages.find((message) => message.id === 1);
assert.equal(
  initialized?.result?.serverInfo?.name,
  "google-tag-manager-mcp-server",
);

const tools = messages.find((message) => message.id === 2)?.result?.tools ?? [];
// Cake fork: read-only. 17 tools, gtm_user_permission dropped, reads only.
assert.equal(tools.length, 17, `expected 17 tools, got ${tools.length}`);
assert.ok(
  !tools.some((tool) => tool.name === "gtm_user_permission"),
  "gtm_user_permission must not be exposed",
);
const WRITE_ACTIONS =
  /^(create|update|remove|revert|publish|setLatest|undelete|combine|moveTagId|moveEntitiesToFolder|createVersion|sync|quickPreview|resolveConflict|reauthorize)$/;
for (const tool of tools) {
  const actions = tool.inputSchema?.properties?.action?.enum ?? [];
  const writes = actions.filter((action) => WRITE_ACTIONS.test(action));
  assert.deepEqual(writes, [], `${tool.name} exposes write actions`);
}
assert.deepEqual(
  tools.find((tool) => tool.name === "gtm_tag").inputSchema.properties.action
    .enum,
  ["get", "list"],
);
// Cake fork: gtm_account list needs no accountId; edit tools still require it.
const accountTool = tools.find((tool) => tool.name === "gtm_account");
assert.ok(
  !(accountTool.inputSchema.required ?? []).includes("accountId"),
  "gtm_account accountId must be optional",
);
assert.deepEqual(accountTool.inputSchema.properties.action.enum, [
  "get",
  "list",
]);
assert.ok(
  tools
    .find((tool) => tool.name === "gtm_tag")
    .inputSchema.required.includes("accountId"),
  "gtm_tag must still require accountId",
);
// Cake fork: the allowed-action note leads every description with an action param.
for (const tool of tools) {
  if (!tool.inputSchema?.properties?.action) continue;
  assert.match(
    tool.description,
    /^Read-only server: only /,
    `${tool.name} description must lead with the allowed actions`,
  );
}
// Cake fork: params only disabled actions read are dropped from read schemas.
const paramsOf = (list, name) =>
  Object.keys(list.find((tool) => tool.name === name).inputSchema.properties);
for (const [name, hidden] of [
  ["gtm_version", ["createOrUpdateConfig", "fingerprint"]],
  ["gtm_workspace", ["entity", "changeStatus", "createOrUpdateConfig"]],
  ["gtm_tag", ["createOrUpdateConfig", "fingerprint"]],
  ["gtm_folder", ["tagId", "triggerId", "variableId"]],
  ["gtm_account", ["config"]],
  ["gtm_built_in_variable", ["type"]],
]) {
  for (const param of hidden) {
    assert.ok(
      !paramsOf(tools, name).includes(param),
      `${name} must not expose ${param} in read mode`,
    );
  }
}
assert.ok(paramsOf(tools, "gtm_tag").includes("tagId"), "gtm_tag keeps tagId");
assert.ok(
  paramsOf(tools, "gtm_version").includes("resourceType"),
  "gtm_version keeps read params",
);
const schemaSize = JSON.stringify(tools).length;
assert.ok(schemaSize < 50000, `read tools/list is ${schemaSize} chars`);
for (const name of ["gtm_account", "gtm_tag", "gtm_workspace"]) {
  assert.ok(
    tools.some((tool) => tool.name === name),
    `missing tool ${name}`,
  );
}

// Cake fork: edit mode adds workspace edits, fails closed, and gates by account.
const editEnv = {
  ...process.env,
  GOOGLE_ACCESS_TOKEN: "smoke-test-token",
  GTM_MODE: "edit",
  GTM_ACCOUNT_ALLOWLIST: "111",
  GTM_AUDIT_LOG: "/dev/null",
};
const edit = await run(
  editEnv,
  [
    ...requests,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "gtm_tag",
        arguments: {
          action: "create",
          accountId: "999",
          containerId: "1",
          workspaceId: "1",
        },
      },
    },
  ]
    .map((request) => `${JSON.stringify(request)}\n`)
    .join(""),
);
assert.equal(edit.code, 0, `edit CLI exited with ${edit.code}\n${edit.stderr}`);
const editMessages = edit.stdout
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const editTools =
  editMessages.find((message) => message.id === 2)?.result?.tools ?? [];
assert.equal(editTools.length, 17, `edit mode: expected 17 tools`);
assert.deepEqual(
  editTools.find((tool) => tool.name === "gtm_tag").inputSchema.properties
    .action.enum,
  ["get", "list", "create", "update", "revert"],
);
// Cake fork: enabled edit actions keep the params they read.
for (const [name, kept] of [
  ["gtm_tag", ["createOrUpdateConfig", "fingerprint"]],
  ["gtm_trigger", ["createOrUpdateConfig", "fingerprint"]],
  ["gtm_variable", ["createOrUpdateConfig", "fingerprint"]],
  ["gtm_built_in_variable", ["type"]],
]) {
  for (const param of kept) {
    assert.ok(
      paramsOf(editTools, name).includes(param),
      `edit mode: ${name} must keep ${param}`,
    );
  }
}
assert.ok(
  !paramsOf(editTools, "gtm_version").includes("createOrUpdateConfig"),
  "edit mode: gtm_version stays read-only",
);
const NEVER_ACTIONS =
  /^(remove|publish|setLatest|undelete|combine|moveTagId|createVersion|sync|quickPreview|resolveConflict|reauthorize)$/;
for (const tool of editTools) {
  const actions = tool.inputSchema?.properties?.action?.enum ?? [];
  assert.deepEqual(
    actions.filter((action) => NEVER_ACTIONS.test(action)),
    [],
    `edit mode: ${tool.name} exposes a forbidden action`,
  );
}
const refused = editMessages.find((message) => message.id === 3)?.result;
assert.ok(refused?.isError, "edit outside the allowlist must be refused");
assert.match(refused.content[0].text, /not in this server's allowlist/);

const editNoAllowlist = await run(
  { ...editEnv, GTM_ACCOUNT_ALLOWLIST: "" },
  "",
);
assert.equal(
  editNoAllowlist.code,
  1,
  "edit mode without allowlist must exit 1",
);

// Cake fork: registerTool() bypasses the allowlists, so it must fail closed.
const { accessControlledServer } =
  await import("../packages/core/dist/index.js");
const fakeServer = { tool: () => {}, registerTool: () => {} };
assert.throws(
  () =>
    accessControlledServer(fakeServer).registerTool("gtm_tag", {}, () => {}),
  /registerTool\(\), which the access filter does not cover/,
);

// Cake fork: edit audit entries carry the ID Google returned for a created entity.
const auditEntries = [];
let registered;
accessControlledServer(
  { tool: (...args) => (registered = args) },
  {
    mode: "edit",
    accountAllowlist: ["1"],
    audit: (entry) => auditEntries.push(entry),
  },
).tool("gtm_tag", "d", {}, async () => ({
  content: [{ type: "text", text: JSON.stringify({ tagId: "42" }) }],
}));
await registered[3](
  { action: "create", accountId: "1", containerId: "2", workspaceId: "3" },
  {},
);
assert.equal(
  auditEntries[0]?.ids?.tagId,
  "42",
  "audit must record created tagId",
);

// Cake fork: a non-numeric ID could path-traverse to another account, so writes refuse it.
const traversal = await registered[3](
  {
    action: "create",
    accountId: "1",
    containerId: "2/../../../9/containers/9",
    workspaceId: "3",
  },
  {},
);
assert.ok(traversal?.isError, "non-numeric ID must be refused");
assert.match(traversal.content[0].text, /containerId must be a numeric GTM ID/);
assert.equal(auditEntries.at(-1)?.result, "refused");
const numberAccount = await registered[3](
  { action: "create", accountId: 1, containerId: "2", workspaceId: "3" },
  {},
);
assert.ok(numberAccount?.isError, "non-string accountId must be refused");

// Cake fork: paged version reads carry only the version identity, not the container.
const { processVersionData } = await import("../packages/core/dist/index.js");
const fullVersion = {
  path: "accounts/1/containers/2/versions/3",
  containerVersionId: "3",
  name: "v3",
  fingerprint: "fp",
  container: { name: "big", publicId: "GTM-X", notes: "x".repeat(2000) },
  tag: Array.from({ length: 25 }, (_, i) => ({ tagId: String(i) })),
};
const page1 = processVersionData(fullVersion, "tag", 1, undefined, false);
assert.deepEqual(
  Object.keys(page1.version).filter((k) => page1.version[k] !== undefined),
  ["path", "containerVersionId", "name", "fingerprint"],
);
assert.equal(page1.tag.length, 20);
assert.equal(page1.tagPagination.hasNextPage, true);
assert.ok(JSON.stringify(page1).length < 1500, "paged read must stay small");
const overview = processVersionData(fullVersion);
assert.equal(
  overview.version.container.name,
  "big",
  "overview keeps the header",
);

const unconfigured = await run(withoutGoogleCredentials(), "");
assert.equal(unconfigured.code, 1, "expected exit code 1 without credentials");
assert.match(unconfigured.stderr, /GOOGLE_SERVICE_ACCOUNT_KEY/);

console.log(`smoke-cli: ok (${tools.length} tools)`);
