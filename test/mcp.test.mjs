import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP starts, lists tools, and keeps payment off by default", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "blinkit-mcp-stdio-"));
  const client = new Client({ name: "blinkit-smoke", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { ...process.env, BLINKIT_STATE_DIR: stateDir, BLINKIT_ENABLE_PAYMENT: "false" },
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert(listed.tools.some((tool) => tool.name === "blinkit_search"));
    const login = await client.callTool({ name: "blinkit_login_status", arguments: {} });
    assert.equal(JSON.parse(login.content[0].text).logged_in, false);
    const payment = await client.callTool({
      name: "blinkit_pay_upi",
      arguments: { cart_id: "123", confirm_payable: 100 },
    });
    assert.equal(payment.isError, true);
    assert.match(payment.content[0].text, /Payment is disabled/);
  } finally {
    await client.close();
  }
});
