# 海龟汤 MVP

AI 主持的海龟汤。裁判层在服务端，汤底不下发。

## 跑起来

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm start          # http://localhost:3000
```

`MODEL` 可选，默认 `claude-sonnet-5`。

## 部署到 Render

Build `npm install`，Start `npm start`，环境变量加 `ANTHROPIC_API_KEY`。
Render 会注入 `PORT`，代码已经读了。

## 结构

```
server.js           Express + 裁判层
puzzles.js          谜题库（solution/facts/keys 永不出服务端）
public/index.html   前端，单文件无构建
```

## 接口

| 路由 | 作用 |
|---|---|
| `GET  /api/puzzles` | 谜题列表（只有 id / 汤色 / 格 / 难度） |
| `POST /api/start`   | 开局，返回 sessionId + 汤面 |
| `POST /api/ask`     | 裁定一问 |
| `POST /api/hint`    | 取下一条提示 |
| `POST /api/giveup`  | 投降，返回汤底 |

## 三条设计约束，改代码时别破坏

**1. 客户端不是可信边界。**
`solution`、`facts`、`keys` 的文本永远不出服务端。已命中的 key 和提问历史存在
服务端 session 里，不由客户端上报——否则玩家可以伪造进度直接触发通关。
`publicView()` 是唯一的下发白名单，加字段时经过它。

**2. 模型没有输出汤底的路径。**
不是靠 prompt 里写「不要泄露」，而是输出 schema 里根本没有那个字段，
`parseVerdict` 只提取 `verdict / keys / solved / note` 四项，`note` 还只在
「换个问法」时保留并截断到 60 字。prompt injection 就算部分成功也无处可去。

**3. 降级优于报错。**
模型返回非法 JSON 时重试一次，再失败就判「无关」。误判一次「无关」代价很小，
崩一次代价是整局。`ANTHROPIC_API_KEY` 填错时整个游戏仍然可玩（全判无关），
这是故意的。

## 已知未做

- **session 存在内存里**，Render 重启或多实例就丢。上线前换 Redis / KV。
- **没有限流。** `/api/ask` 每次都打 Claude API，裸奔上线会被刷爆。
  加个按 IP 的令牌桶，或者要求先过一个轻量验证。
- **没有分享卡片。** 你原来那个 Wordle 式分享是拉新的主要抓手，值得早点加回来。
  建议分享内容用「N 问见底 + 判定序列（■□◌）」，不泄露题目。
- **谜题只有 3 题。** 见下。

## 下一步：先验证 key 命中判定

整套设计里我最没把握的是模型能否稳定区分「擦边」和「真的想到了」。
这决定清晰度条准不准，也决定通关判定会不会误触发。

验证方法：拿 `xuanguan-tuoxie` 自己玩五局，每局记录：
- 有没有出现「明明问到点子上了但没给 key」
- 有没有出现「随便问一句就给了 key」
- `solved` 有没有在玩家只猜中一个要素时误触发

如果 key 判定偏松，把 prompt 里「想到」的定义收紧（要求问题必须**预设**该认知，
而不是提及相关词）。如果偏紧，在每个 key 的 `need` 里补一句「以下问法算命中：…」。

调完再扩库到 15–20 题。库先大后调，等于用错误的尺子量了一整批。
