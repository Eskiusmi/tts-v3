// npm run generate -- [数量]
//
// 离线生成谜题，逐个跑验证，只把活下来的写进 pool.json。
// 不在玩家的请求路径上——这是整个设计的关键。
//
// 验证有三关：
//   1. 结构检查（纯代码，免费）
//   2. 题面诚实性（一次模型调用）—— 题面里有没有假话
//   3. 模拟对局（约 12 次调用）—— 让模型真的去玩，看能不能收敛
//
// 第 3 关是质量线第 3 条的自动化版本，也是最贵的一关，所以放最后。

import { readFile, writeFile } from "node:fs/promises";
import { anthropic, MODEL, adjudicate, reportAuth } from "./adjudicator.js";
import { PUZZLES } from "./puzzles.js";

const POOL_PATH = new URL("./pool.json", import.meta.url);
const WANT = Number(process.argv[2] || 5);
// 模拟对局用便宜模型就够，它只负责提问不负责裁定
const SOLVER_MODEL = process.env.SOLVER_MODEL || "claude-haiku-4-5-20251001";
const MAX_SIM_TURNS = 12;

/* ---------- 反套路：强制换杠杆和题材 ---------- */
// 不给约束的话模型会反复产出「死去的妻子 / 镜子 / 盲人 / 双胞胎」。
const LEVERS = [
  "省略主语——题面从头到尾不出现「谁」，读者会自动补一个错的主语",
  "身份错位——读者默认叙述者的身份，实际是另一种人",
  "时间错位——读者默认事件是当下发生的，实际早已结束",
  "数量错位——读者默认只有一个，实际有两个或更多",
  "场所错位——读者默认场景在某处，实际在别处"
];
const SETTINGS = [
  "医院或诊所", "出租车或网约车", "老旧居民楼", "便利店夜班",
  "长途火车", "小学门口", "殡仪馆", "健身房", "菜市场",
  "写字楼电梯", "海边渔村", "汽修厂", "图书馆", "澡堂"
];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

/* ---------- 生成 ---------- */
const GEN_PROMPT = `你在为一个中文海龟汤游戏创作原创谜题。

海龟汤规则：玩家只看到【汤面】，通过是非问句向主持人提问，逐步推出【汤底】。

绝对要求（违反其一即作废）：
1. 汤面里不能有任何假陈述。误导只能来自读者的预设，不能来自你撒谎。
   汤面的每一句话，在汤底成立的前提下，都必须字面为真。
2. 汤面不超过 60 字。
3. 汤底的每个环节都必须能被是非问句问出来。不要靠谐音、拆字或字谜。
4. 不要写以自杀方式为谜底的题，也不要让汤底落在「他是怎么自杀的」上。
5. 不要用这些烂大街的套路：死去的妻子、镜子里的人、盲人、双胞胎、
   梦境、机器人、时间循环、其实是动物。

facts 是主持人裁定时的唯一依据，必须写足 8 条以上，并且**必须包含否定事实**
（例如「不涉及超自然」「没有人被胁迫」「没有人认错人」）。
不写否定事实的话，玩家一探这些方向主持人就会自己编。

keys 是玩家必须想到的 3 个认知，不是故事里的事件。

只输出这个 JSON，不要有任何其他文字：
{
  "id": "英文小写连字符短 id",
  "broth": "清汤或红汤",
  "genre": "本格",
  "difficulty": 2到4的整数,
  "scene": "汤面",
  "solution": "汤底，一到两句",
  "facts": ["...", "..."],
  "keys": [{"id":"k1","need":"..."},{"id":"k2","need":"..."},{"id":"k3","need":"..."}],
  "hints": ["第一条提示，指向 k1", "第二条提示，指向 k2"]
}`;

async function generate() {
  const lever = pick(LEVERS);
  const setting = pick(SETTINGS);
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1600,
    system: GEN_PROMPT,
    messages: [{
      role: "user",
      content: `出一道新题。\n本题必须使用这个手法：${lever}\n场景设定在：${setting}\n只输出 JSON。`
    }]
  });
  const text = res.content.filter(b => b.type === "text").map(b => b.text).join("");
  const o = text.indexOf("{"), c = text.lastIndexOf("}");
  if (o === -1) throw new Error("生成结果里没有 JSON");
  const p = JSON.parse(text.slice(o, c + 1));
  p.locale = "zh";
  p.lever = lever.split("——")[0];
  p.generated = true;
  return p;
}

/* ---------- 第 1 关：结构 ---------- */
function checkStructure(p) {
  const bad = [];
  const len = [...(p.scene || "")].length;
  if (!p.id || !/^[a-z0-9-]+$/.test(p.id)) bad.push("id 不合法");
  if (!p.scene || len > 60) bad.push(`汤面 ${len} 字，超过 60`);
  if (!p.solution) bad.push("没有汤底");
  if (!Array.isArray(p.facts) || p.facts.length < 8) bad.push(`facts 只有 ${p.facts?.length ?? 0} 条，少于 8`);
  if (!Array.isArray(p.keys) || p.keys.length < 3 || p.keys.length > 5) bad.push("keys 数量不在 3-5");
  if (!Array.isArray(p.hints) || p.hints.length < 2) bad.push("提示少于 2 条");
  if (!["清汤", "红汤"].includes(p.broth)) bad.push("broth 不合法");
  // 否定事实：facts 里至少要有几条是在排除可能性的
  const negatives = (p.facts || []).filter(f => /不|没有|无/.test(f)).length;
  if (negatives < 2) bad.push(`否定事实只有 ${negatives} 条，主持人会自己编`);
  return bad;
}

/* ---------- 第 2 关：题面诚实性 ---------- */
async function checkHonesty(p) {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 400,
    system: `你在审校一道海龟汤谜题。给你汤面和汤底。

逐句检查汤面：在汤底成立的前提下，这句话是否**字面为真**？
误导读者是允许的（读者自己补错了预设）；陈述假事实是不允许的。
另外检查：汤底是否能仅通过是非问句推出？有没有需要凭空跳跃的环节？

只输出 JSON：{"honest":true/false,"solvable":true/false,"why":"不通过时说明哪一句有问题"}`,
    messages: [{ role: "user", content: `汤面：${p.scene}\n汤底：${p.solution}` }]
  });
  const t = res.content.filter(b => b.type === "text").map(b => b.text).join("");
  const o = t.indexOf("{"), c = t.lastIndexOf("}");
  return JSON.parse(t.slice(o, c + 1));
}

/* ---------- 第 3 关：模拟对局 ---------- */
async function simulate(p) {
  const session = { hit: [], history: [] };
  const asked = [];

  for (let turn = 0; turn < MAX_SIM_TURNS; turn++) {
    const res = await anthropic.messages.create({
      model: SOLVER_MODEL,
      max_tokens: 120,
      system: `你在玩海龟汤，只能提是非问句。目标是尽快推出汤底。
根据已有的问答缩小范围，不要重复问过的方向。只输出你的下一个问题，不要有其他文字。`,
      messages: [{
        role: "user",
        content: `汤面：${p.scene}\n\n已问：\n${
          asked.length ? asked.map((a, i) => `${i + 1}. ${a.q} → ${a.v}`).join("\n") : "（还没问）"
        }\n\n你的下一个问题：`
      }]
    });
    const q = res.content.filter(b => b.type === "text").map(b => b.text).join("").trim().slice(0, 100);
    if (!q) break;

    const out = await adjudicate(p, session, q);
    if (out.degraded) return { ok: false, why: "模拟时裁判降级了" };
    if (out.verdict !== "换个问法") {
      session.history.push({ q, verdict: out.verdict });
      session.hit.push(...out.keys);
    }
    asked.push({ q, v: out.verdict });
    if (session.hit.length >= p.keys.length) break;
  }

  const mootRate = asked.filter(a => a.v === "无关").length / Math.max(1, asked.length);
  return {
    ok: session.hit.length >= p.keys.length && mootRate < 0.6,
    hit: session.hit.length,
    total: p.keys.length,
    turns: asked.length,
    mootRate: Math.round(mootRate * 100),
    why: session.hit.length < p.keys.length
      ? `${MAX_SIM_TURNS} 问只命中 ${session.hit.length}/${p.keys.length}`
      : `无关率 ${Math.round(mootRate * 100)}% 过高，facts 太薄`
  };
}

/* ---------- 主流程 ---------- */
reportAuth();

let pool = [];
try { pool = JSON.parse(await readFile(POOL_PATH, "utf8")); } catch { /* 首次运行 */ }
const taken = new Set([...PUZZLES.map(p => p.id), ...pool.map(p => p.id)]);

let kept = 0, tried = 0;
const MAX_TRIES = WANT * 4;   // 预期要扔掉大部分

while (kept < WANT && tried < MAX_TRIES) {
  tried++;
  process.stdout.write(`\n[${tried}] 生成… `);
  let p;
  try { p = await generate(); }
  catch (e) { console.log("✗ 生成失败:", e.message); continue; }

  if (taken.has(p.id)) p.id = `${p.id}-${Date.now().toString(36).slice(-4)}`;
  process.stdout.write(`「${p.scene.slice(0, 20)}…」\n`);

  const structural = checkStructure(p);
  if (structural.length) { console.log("   ✗ 结构:", structural.join("；")); continue; }
  console.log("   ✓ 结构");

  let honesty;
  try { honesty = await checkHonesty(p); }
  catch (e) { console.log("   ✗ 诚实性检查出错:", e.message); continue; }
  if (!honesty.honest) { console.log("   ✗ 题面有假话:", honesty.why); continue; }
  if (!honesty.solvable) { console.log("   ✗ 不可解:", honesty.why); continue; }
  console.log("   ✓ 题面诚实、可解");

  process.stdout.write("   模拟对局…");
  const sim = await simulate(p);
  if (!sim.ok) { console.log(` ✗ ${sim.why}`); continue; }
  console.log(` ✓ ${sim.turns} 问命中 ${sim.hit}/${sim.total}，无关率 ${sim.mootRate}%`);

  p.verified = { turns: sim.turns, mootRate: sim.mootRate, at: new Date().toISOString() };
  pool.push(p);
  taken.add(p.id);
  kept++;
  console.log(`   ✓ 收录 ${p.id}`);
}

await writeFile(POOL_PATH, JSON.stringify(pool, null, 2) + "\n", "utf8");
console.log(`\n生成 ${tried} 题，通过 ${kept} 题，题池共 ${pool.length} 题。`);
if (kept < WANT) console.log(`（没凑够 ${WANT} 题，再跑一次即可——扔掉大部分是正常的。）`);
