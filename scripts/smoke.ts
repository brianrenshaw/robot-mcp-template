// A quick end-to-end check of the server, through the token route (the one Claude Code and
// scripts use). Start the server first (npm run dev), then: npm run smoke
// Against the deployed server: MCP_URL=https://<your address>/mcp MCP_TOKEN=<your token> npm run smoke
// It adds one test note and removes it again.

const URL_ = process.env.MCP_URL ?? "http://localhost:8787/mcp";
const TOKEN = process.env.MCP_TOKEN ?? "testtoken";
let id = 1;

async function call(method: string, params: unknown = {}) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${TOKEN}`,
      "MCP-Protocol-Version": "2025-06-18",
      "X-Client-Name": "smoke-test",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${text.slice(0, 200)}`);
  const json = text.includes("data:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text;
  const msg = JSON.parse(json);
  if (msg.error) throw new Error(`${method}: ${JSON.stringify(msg.error)}`);
  return msg.result;
}

async function tool(name: string, args: Record<string, unknown> = {}) {
  const r = await call("tools/call", { name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* plain text */
  }
  return { isError: !!r.isError, data };
}

function check(label: string, cond: boolean, detail?: unknown) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) {
    console.log("      ", JSON.stringify(detail)?.slice(0, 400));
    process.exitCode = 1;
  }
}

async function main() {
  // What the chatbot is told has to arrive whole: chat apps cut long text without saying so.
  const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke-test", version: "1" } });
  const instructions: string = init.instructions ?? "";
  check("instructions are sent and under 4,000 characters", instructions.length > 0 && instructions.length < 4000, instructions.length);

  const { tools } = await call("tools/list");
  check("the server lists its tools", tools.length > 0, tools.length);
  const long = tools.filter((t: any) => (t.description ?? "").length >= 2000).map((t: any) => `${t.name} (${t.description.length})`);
  check("every tool description is under 2,000 characters", long.length === 0, long);

  const title = `Smoke test ${Math.random().toString(36).slice(2, 8)} (safe to ignore)`;
  const added = await tool("add_note", { title, body: "Written by the smoke test." });
  check("add_note saves a note and gives a receipt", !added.isError && added.data.created === true && typeof added.data.receipt === "string", added.data);
  check("the note is marked with who wrote it", added.data.note?.written_by === "mcp:smoke-test", added.data.note);

  const found = await tool("list_notes", { query: title });
  check("list_notes finds it", !found.isError && found.data.count === 1, found.data);
  check("an ordinary list carries no routine", found.data.how_to === undefined, found.data.how_to);

  const tidy = await tool("list_notes", { tidy: true });
  check("the tidy routine arrives with the tool it starts with", Array.isArray(tidy.data.how_to), tidy.data.how_to);

  const changed = await tool("update_note", { note: title, body: "Changed by the smoke test." });
  check("update_note finds the note by its title", !changed.isError && changed.data.updated === true, changed.data);

  const missing = await tool("update_note", { note: "no note is called this zzqx", body: "x" });
  check("a note that does not exist is an error, not a guess", missing.isError, missing.data);

  const removed = await tool("delete_note", { note: added.data.note.id });
  check("delete_note removes it", !removed.isError && removed.data.removed === true, removed.data);
  const gone = await tool("list_notes", { query: title });
  check("the removed note is no longer listed", gone.data.count === 0, gone.data);

  const back = await tool("delete_note", { note: added.data.note.id, restore: true });
  check("restore brings it back", !back.isError && back.data.restored === true, back.data);
  await tool("delete_note", { note: added.data.note.id });

  const res = await fetch(URL_, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer not-the-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }) });
  check("a wrong token is refused", res.status === 401, res.status);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
