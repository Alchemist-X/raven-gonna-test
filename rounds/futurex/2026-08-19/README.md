# FutureX 2026-08-19 · submission candidate

最后更新：2026-08-18　　英文版见 [`README.en.md`](README.en.md)

> **尚未提交。** FutureX 没有提交 API，只接受发往 `FutureX-ai@outlook.com` 的邮件，
> 本仓库没有任何命令能对外发送。这里存的是等待人工确认的候选件。

## 这是什么

`claude-sonnet-5` 单模型跑完本轮 **80 道全部题目**，harness 固定不变。

| 项 | 值 |
| --- | --- |
| 模型 | `claude-sonnet-5`（provider `claude-cli`，走 Claude 订阅额度） |
| 证据冻结 as-of | `2026-08-18T02:25:21Z` |
| 提交截止 | 2026-08-19 24:00 (UTC+8) |
| 题库版本 | `2841bff13f6d2f679298ce7007e91ae585f4ade1` |
| 提交件 sha256 | `a49eb546cb4f44761c2195104a2ce3d542d0f3b85d8ff64807a37bcc111e0245` |
| 校验 | `valid: True`，coverage 1.0，0 error |
| 兜底答案 | 0 |
| 题型分布 | numeric 32 / categorical 37 / free_response 11 |

## 检索深度

算力按 level 分配（trials 1/2/3/4），**effort 一律 high**——实测 low effort 会让模型完全跳过检索。

| Level | 题数 | trials | 平均来源/trial |
| --- | --- | --- | --- |
| L1 | 20 | 20 | 36.0 |
| L2 | 17 | 34 | 29.1 |
| L3 | 21 | 62 | 48.5 |
| L4 | 22 | 86 | 57.1 |

零检索题 **0**，兜底题 **0**。

## 文件

| 文件 | 说明 |
| --- | --- |
| `submission-sonnet5.jsonl` | 官方格式 `{id, prediction}`，80 行 —— 提交时的附件就是这个 |
| `submission-sonnet5.reasoning.jsonl` | 每题每 trial 的 persona / thinking / 引用 / 原始回复 / token 成本 |
| `submission-sonnet5.review.html` | 浏览器评审页，按分数权重排序并标出待复核项 |
| `submission-sonnet5.jsonl.manifest.json` | 出处、sha256、校验报告 |
| `routes.json` | 本轮题型路由，80/80 已 approved |

## 复现

```bash
PREDICTOR_PROVIDER=claude-cli PREDICTOR_MODEL=claude-sonnet-5 PREDICTOR_TRIALS=4 \
npx tsx apps/benchmark-cli/src/main.ts futurex run \
  --input runtime-artifacts/futurex/2026-08-19/questions.json \
  --routes runtime-artifacts/futurex/2026-08-19/routes.json \
  --revision 2841bff13f6d2f679298ce7007e91ae585f4ade1 --round 2026-08-19 \
  --as-of 2026-08-18T02:25:21Z --deadline 2026-08-19T16:00:00Z \
  --output <out>.jsonl --allow-paid

node scripts/futurex-review-page.mjs <round-dir> <out>.jsonl
```

## 人工判断记录

1. **HMRC 税收题的量纲 —— 已裁决（2026-08-18，用户）。** 四个 trial 里三个按十亿英镑、一个按百万英镑作答——同一估计、不同单位，差 1000 倍。聚合曾按多数取十亿（`97.58`）；用户裁决改为**百万口径 `97583`**，理由：HMRC 官方月报表格以百万英镑列示，评分对照的是官方公布值。改动记录在 manifest 的 `manualOverrides`，提交件 sha256 已同步更新。
2. **数值路径没有跨 trial 单位归一化（已知局限，本轮不修）。** prompt 里带字段名的题（如 `revenue_usd_millions`）不受影响；没有字段名的题暴露。未加启发式修正，因为猜错单位比不猜更糟——由 review 页的 unit-scale 标记交人工裁决。
