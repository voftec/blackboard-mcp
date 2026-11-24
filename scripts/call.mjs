import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const env = { ...getDefaultEnvironment(), DISPLAY: process.env.DISPLAY ?? ":0", XAUTHORITY: process.env.XAUTHORITY ?? "/home/ubuntu/.Xauthority", BLACKBOARD_BROWSER_CHANNEL: process.env.BLACKBOARD_BROWSER_CHANNEL ?? "chromium", PLAYWRIGHT_BROWSERS_PATH: "/opt/.devin/playwright_browsers" };
const client = new Client({ name: "call", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: [join(root, "dist/index.js")], env, stderr: "inherit" }));
const [, , tool, rawArgs] = process.argv;
if (tool === "login") {
  const res = await client.callTool({ name: "login", arguments: rawArgs ? JSON.parse(rawArgs) : {} });
  console.log(res.content?.[0]?.text);
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = JSON.parse((await client.callTool({ name: "session_status", arguments: {} })).content[0].text);
    console.log(`login=${st.login.status} loggedIn=${st.loggedIn} ${st.login.message ?? ""}`);
    if (st.login.status !== "pending" || st.loggedIn) break;
  }
} else {
  const res = await client.callTool({ name: tool, arguments: rawArgs ? JSON.parse(rawArgs) : {} });
  console.log(res.content?.[0]?.text ?? "");
}
await client.close();
