// Drives the built MCP server over stdio and calls each tool once.
// Usage: node scripts/smoke.mjs [toolName] [jsonArgs]      (FULL=1 prints untruncated JSON only)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: [join(root, "dist/index.js")], stderr: "inherit" }));

const call = async (name, args = {}) => {
  const started = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (process.env.FULL) {
    console.log(text);
    return JSON.parse(text);
  }
  console.log(`\n=== ${name} ${JSON.stringify(args)} (${Date.now() - started} ms)${res.isError ? " [ERROR]" : ""}`);
  console.log(text.length > 3500 ? `${text.slice(0, 3500)}\n… (${text.length} chars total)` : text);
  return JSON.parse(text);
};

const [, , only, rawArgs] = process.argv;
if (only === "login") {
  const res = await call("login", rawArgs ? JSON.parse(rawArgs) : {});
  for (let i = 0; res.status === "pending" && i < 100; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const status = await client.callTool({ name: "session_status", arguments: {} }).then((r) => JSON.parse(r.content[0].text));
    console.log(`[${new Date().toLocaleTimeString()}] login=${status.login.status} loggedIn=${status.loggedIn}${status.login.message ? ` - ${status.login.message}` : ""}`);
    if (status.login.status !== "pending") break;
  }
} else if (only) {
  await call(only, rawArgs ? JSON.parse(rawArgs) : {});
} else {
  const tools = (await client.listTools()).tools.map((t) => t.name);
  console.log("tools:", tools.join(", "));
  const status = await call("session_status");
  if (!status.loggedIn) {
    console.log("Not logged in - run `node scripts/smoke.mjs login` and sign in, then rerun.");
  } else {
    const { courses } = await call("find_courses");
    const courseId = courses[0]?.id;
    if (courseId) {
      await call("get_course", { courseId });
      await call("find_homework", { courseId });
      await call("get_course_content", { courseId, depth: 1 });
    }
    await call("get_upcoming_homework", { days: 30 });
    await call("get_todo");
    await call("get_recent_content", { days: 30, limit: 15 });
    await call("get_activity_stream", { limit: 10 });
    await call("get_messages", { limit: 5 });
    await call("get_briefing", { days: 14 });
  }
}
await client.close();
