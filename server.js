import express from "express";
import crypto from "node:crypto";
import { PUZZLES, byId, publicView } from "./puzzles.js";
import { loadPool } from "./pool.js";
import { adjudicate, reportAuth } from "./adjudicator.js";

reportAuth();
await loadPool();          // 把验证通过的生成题并入题库

const app = express();
// Render 在反向代理后面，不设这个拿到的 IP 全是代理的
app.set("trust proxy", 1);
app.use(express.json({ limit: "8kb" }));
app.use(express.static("public"));

app.get("/healthz", (_req, res) => res.type("text").send("ok"));

// 每次 /api/ask 都要花钱调 Claude API。没有这个，一个脚本能在几分钟内
// 刷掉你一个月的额度。按 IP 令牌桶：初始 20 次，每 6 秒回一次。
const BUCKET_MAX = 20;
const REFILL_MS = 6000;
const buckets = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip || "unknown";
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) { b = { tokens: BUCKET_MAX, last: now }; buckets.set(ip, b); }
  b.tokens = Math.min(BUCKET_MAX, b.tokens + (now - b.last) / REFILL_MS);
  b.last = now;
  if (b.tokens < 1) {
    return res.status(429).json({ error: "too_many_requests" });
  }
  b.tokens -= 1;
  next();
}

setInterval(() => {
  const cutoff = Date.now() - 1000 * 60 * 30;
  for (const [ip, b] of buckets) if (b.last < cutoff) buckets.delete(ip);
}, 1000 * 60 * 10).unref();

const sessions = new Map();
const TTL = 1000 * 60 * 60 * 3;

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.touched > TTL) sessions.delete(id);
}, 1000 * 60 * 10).unref();

/* ---------------- routes ---------------- */

app.get("/api/puzzles", (_req, res) => {
  res.json(PUZZLES.map((p) => ({
    id: p.id, broth: p.broth, genre: p.genre, difficulty: p.difficulty
  })));
});

app.post("/api/start", (req, res) => {
  const puzzle = byId(req.body?.puzzleId) || PUZZLES[0];
  const sid = crypto.randomUUID();
  sessions.set(sid, {
    puzzleId: puzzle.id, hit: [], history: [],
    hintsUsed: 0, over: false, touched: Date.now()
  });
  res.json({ sessionId: sid, puzzle: publicView(puzzle) });
});

app.post("/api/ask", rateLimit, async (req, res) => {
  const { sessionId, question } = req.body || {};
  const s = sessions.get(sessionId);
  if (!s) return res.status(404).json({ error: "session_expired" });
  if (s.over) return res.status(409).json({ error: "game_over" });

  const q = String(question || "").trim().slice(0, 200);
  if (!q) return res.status(400).json({ error: "empty_question" });

  s.touched = Date.now();
  const puzzle = byId(s.puzzleId);
  const out = await adjudicate(puzzle, s, q);

  // 「换个问法」不计入提问数，也不推进进度。
  if (out.verdict !== "换个问法") {
    s.history.push({ q, verdict: out.verdict });
    s.hit.push(...out.keys);
  }
  if (out.solved) s.over = true;

  res.json({
    verdict: out.verdict,
    note: out.note,
    newKeys: out.keys.length,
    hitKeys: s.hit.length,
    totalKeys: puzzle.keys.length,
    asked: s.history.length,
    solved: out.solved,
    degraded: out.degraded === true,
    // 只有通关才下发汤底
    solution: out.solved ? puzzle.solution : undefined
  });
});

app.post("/api/hint", (req, res) => {
  const s = sessions.get(req.body?.sessionId);
  if (!s) return res.status(404).json({ error: "session_expired" });
  const puzzle = byId(s.puzzleId);
  if (s.hintsUsed >= puzzle.hints.length) {
    return res.status(409).json({ error: "no_more_hints" });
  }
  const hint = puzzle.hints[s.hintsUsed++];
  s.touched = Date.now();
  res.json({ hint, hintsUsed: s.hintsUsed, totalHints: puzzle.hints.length });
});

app.post("/api/giveup", (req, res) => {
  const s = sessions.get(req.body?.sessionId);
  if (!s) return res.status(404).json({ error: "session_expired" });
  const puzzle = byId(s.puzzleId);
  s.over = true;
  res.json({ solution: puzzle.solution, asked: s.history.length, gaveUp: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`海龟汤 listening on ${PORT}`));
