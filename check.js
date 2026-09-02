// npm run check
// 单独打一次 API，把真实错误原样打出来，不走降级。
import Anthropic from "@anthropic-ai/sdk";

const key = process.env.ANTHROPIC_API_KEY;
const model = process.env.MODEL || "claude-sonnet-5";
const ws = (process.env.ANTHROPIC_WORKSPACE_ID || "").trim();

console.log("--- 环境 ---");
console.log("Node        :", process.version);
console.log("MODEL       :", model);
console.log("WORKSPACE   :", ws || "(未设置)");

if (!key) {
  console.error("\n✗ ANTHROPIC_API_KEY 完全没有设置。");
  console.error("  本地：放进 .env，然后 npm run check（会自动读取）");
  console.error("  Render：后台 Environment 里加，加完要 Manual Deploy 才生效。");
  process.exit(1);
}

console.log("KEY 长度    :", key.length);
console.log("KEY 前缀    :", key.slice(0, 7) + "…");
if (key !== key.trim())         console.warn("⚠ KEY 首尾有空白字符。");
if (/^["']|["']$/.test(key))    console.warn("⚠ KEY 被引号包住了，去掉引号。");
if (!key.startsWith("sk-ant-")) console.warn("⚠ KEY 不是 sk-ant- 开头。");
if (ws && !ws.startsWith("wrkspc_")) console.warn("⚠ workspace id 通常是 wrkspc_ 开头。");

console.log("\n--- 调用 ---");
const anthropic = new Anthropic({
  apiKey: key.trim(),
  ...(ws ? { defaultHeaders: { "anthropic-workspace-id": ws } } : {})
});

try {
  // .withResponse() 能拿到响应头，里面带回实际生效的 workspace
  const { data, response } = await anthropic.messages
    .create({ model, max_tokens: 16, messages: [{ role: "user", content: "只回复 OK" }] })
    .withResponse();

  const text = data.content.filter(b => b.type === "text").map(b => b.text).join("");
  console.log("✓ 成功。模型回复：", JSON.stringify(text));
  console.log("  实际模型  :", data.model);
  const resolved = response.headers.get("anthropic-workspace-id");
  if (resolved) {
    console.log("  生效 workspace:", resolved);
    if (!ws) console.log("  （key 已绑定该 workspace，不需要额外设 ANTHROPIC_WORKSPACE_ID）");
  }
} catch (err) {
  const msg = err.error?.error?.message ?? err.message;
  console.error("✗ 失败");
  console.error("  status :", err.status ?? "(无)");
  console.error("  type   :", err.error?.error?.type ?? err.name);
  console.error("  message:", msg);

  if (/anthropic-workspace-id/i.test(msg)) {
    console.error(`
  → 这个 key 可以在多个 workspace 上使用，所以每次请求都要指明用哪个。
    两条路，选一条：

    A. 换 key（推荐，不用改代码）
       Console → Settings → API keys → Create key，
       创建时把 key 限定到某一个 workspace。之后请求不需要再带 workspace id。

    B. 补上 workspace id
       Console → Settings → Workspaces，复制目标 workspace 的 wrkspc_ 开头 ID，
       设成环境变量 ANTHROPIC_WORKSPACE_ID。
       Render 上加完记得 Manual Deploy。`);
    process.exit(1);
  }

  const hint = {
    401: "key 无效或已被撤销。去 Console 确认这个 key 还在。",
    403: "key 有效但没权限，可能属于另一个组织或该 workspace 没开通这个模型。",
    404: `模型名 "${model}" 不存在或无权访问。试试 MODEL=claude-haiku-4-5-20251001。`,
    429: "触发速率限制，等一分钟再试。"
  }[err.status];
  if (hint) console.error("\n  → " + hint);
  if (/credit|balance/i.test(msg)) console.error("  → 账户余额不足，Console → Billing。");
  process.exit(1);
}
