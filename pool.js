import { readFile } from "node:fs/promises";
import { PUZZLES } from "./puzzles.js";

const POOL_PATH = new URL("./pool.json", import.meta.url);

// 生成的题经 generate.js 验证后写进 pool.json。
// 服务端只是读进来——它不知道也不关心这些题是怎么来的。
export async function loadPool() {
  try {
    const raw = await readFile(POOL_PATH, "utf8");
    const pool = JSON.parse(raw);
    if (!Array.isArray(pool)) throw new Error("pool.json 不是数组");

    const existing = new Set(PUZZLES.map((p) => p.id));
    let added = 0;
    for (const p of pool) {
      if (existing.has(p.id)) continue;
      // 服务端不信任文件内容，缺字段的直接跳过，不让它进到玩家面前
      if (!p.scene || !p.solution || !Array.isArray(p.facts) || !Array.isArray(p.keys)) {
        console.warn(`⚠ pool 里的 ${p.id ?? "(无 id)"} 字段不全，已跳过。`);
        continue;
      }
      PUZZLES.push(p);
      existing.add(p.id);
      added++;
    }
    console.log(`✓ 题池载入 ${added} 题，题库共 ${PUZZLES.length} 题。`);
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log("· 没有 pool.json，只用手写题库。跑 npm run generate 生成。");
    } else {
      console.error("⚠ 题池载入失败：", err.message, "— 继续用手写题库。");
    }
  }
}
