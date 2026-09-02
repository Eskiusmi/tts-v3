// npm run check
// 单独打一次 API，把真实错误原样打出来，不走降级。
import Anthropic from "@anthropic-ai/sdk";

const key = process.env.ANTHROPIC_API_KEY;
const model = process.env.MODEL || "claude-sonnet-5";

console.log("--- 环境 ---");
console.log("Node        :", process.version);
console.log("MODEL       :", model);

if (!key) {
  console.error("\n✗ ANTHROPIC_API_KEY 完全没有设置。");
  console.error("  本地：export ANTHROPIC_API_KEY=sk-ant-...");
  console.error("  或者放进 .env，然后用  node --env-file=.env check.js");
  console.error("  Render：后台 Environment 里加，加完要 Manual Deploy 才生效。");
  process.exit(1);
}

// 只打印形状，不打印内容
console.log("KEY 长度    :", key.length);
console.log("KEY 前缀    :", key.slice(0, 7) + "…");
if (key !== key.trim())            console.warn("⚠ KEY 首尾有空白字符，粘贴时带进来了。");
if (/^["']|["']$/.test(key))       console.warn("⚠ KEY 被引号包住了，Render 后台不需要加引号。");
if (!key.startsWith("sk-ant-"))    console.warn("⚠ KEY 不是 sk-ant- 开头，可能不是 Anthropic 的 key。");

console.log("\n--- 调用 ---");
const anthropic = new Anthropic({ apiKey: key.trim() });

try {
  const res = await anthropic.messages.create({
    model,
    max_tokens: 16,
    messages: [{ role: "user", content: "只回复 OK 两个字母" }]
  });
  const text = res.content.filter(b => b.type === "text").map(b => b.text).join("");
  console.log("✓ 成功。模型回复：", JSON.stringify(text));
  console.log("  实际模型：", res.model);
} catch (err) {
  console.error("✗ 失败");
  console.error("  status :", err.status ?? "(无)");
  console.error("  type   :", err.error?.error?.type ?? err.name);
  console.error("  message:", err.error?.error?.message ?? err.message);

  const hint = {
    401: "key 无效或已被撤销。去 Console 确认这个 key 还在，或重新生成一个。",
    403: "key 有效但没有权限，可能属于另一个组织，或该组织没开通这个模型。",
    404: `模型名 "${model}" 不存在或你的账号无权访问。换 MODEL 环境变量试试 claude-haiku-4-5-20251001。`,
    429: "触发了速率限制。等一分钟再试。",
    400: "请求格式问题——如果只有 check 报这个，说明 SDK 版本和参数对不上。"
  }[err.status];
  if (hint) console.error("\n  → " + hint);

  if (err.status === 400 && /credit|balance/i.test(err.error?.error?.message || "")) {
    console.error("  → 账户余额不足。Console → Billing 充值。");
  }
  process.exit(1);
}
