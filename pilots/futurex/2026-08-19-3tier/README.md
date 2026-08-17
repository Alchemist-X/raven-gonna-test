# FutureX 2026-08-19 · Raven 三档试跑（pilot）

最后更新：2026-08-17

> ⚠️ **这不是本轮的提交件。** `manifest.json` 里 `submissionEligible` 恒为 `false`。
> 文件用的是官方 `{id, prediction}` JSONL 格式，但**不满足提交条件**，理由见下方"为什么不能提交"。

英文版见 [`README.en.md`](README.en.md)。

## 这是什么

用 `predict-raven` 的 FutureX adapter，把同一批题目在**三个模型档位**上各跑一遍，看档位差异到底买到了什么。

| 档位 | 模型 | effort | 证据轮上限 |
| --- | --- | --- | --- |
| Urd / low | `claude-haiku-4-5-20251001` | low | 1 |
| Verdandi / medium | `claude-sonnet-5` | medium | 2 |
| Skuld / high | `claude-opus-5` | high | 3 |

12 道二元题 × 3 档 = 36 个作业，全部完成，零失败。

## 主要结论

**三档在 12 道题里只有 1 道给出不同答案，而那 1 道是低档位的重大翻车。**

题目：*Will Armand Duplantis clear 6.20m at the 2026 Athletissima men's pole vault?*

| 档位 | P(Yes) | 答案 | 证据数 |
| --- | --- | --- | --- |
| Urd | 94.3% | A = Yes | 4 |
| Verdandi | 2.7% | B = No | 7 |
| Skuld | 2.0% | B = No | 16 |

极差 92.3pp。6.20m 是世界纪录级高度，高档位判 2% 是合理的；Urd 只跑 1 轮、找到 4 条证据就给了 94%，方向完全反了。**档位的价值不在于精度提升几个点，而在于避免一次离谱的错误。**

其余观察：

- 证据数随档位单调上升（Urd 3–6 / Verdandi 5–9 / Skuld 8–20）。
- Skuld 有 5 道题顶到 0.99，存在饱和倾向，值得盯。
- 账面成本 Urd $8.37 / Verdandi $38.21 / Skuld $53.94（CLI 按 API 等价价格计，实际走 Max 订阅额度）。
- 耗时 Urd 56.6 分 / Verdandi 56.0 分 / Skuld 136.8 分（三档并行）。

## 为什么不能提交

1. **覆盖率 12/80。** 本轮 80 道题里，只有 12 道是二元题（6 道直答 `\boxed{Yes}/\boxed{No}` + 6 道二选一 `\boxed{A}/\boxed{B}`）。其余 68 道是 numeric / single_choice / open_text / ranking，当前二元引擎接不了，被 `executableByRaven: false` 主动阻断。
2. **没走 `futurex run` 协议。** 产物来自 `predict-raven` 的 adapter，不是本仓库的正式 submission 管线。
3. **route 未审核。** 生成时 `routes.json` 里 80 条全是 `review.status: pending`；README 明确要求正式 run 在调用模型前阻断 pending route。

要变成真正的提交件，这三件事都得补上。

## 文件

| 文件 | 说明 |
| --- | --- |
| `submission-{urd,verdandi,skuld}.jsonl` | 各档答案，官方 `{id, prediction}` 格式，每份 12 行 |
| `manifest.json` | 出处、覆盖率、eligibility、两个仓库的 HEAD SHA |
| `three-tier-report.pdf` | 完整对比报告：适配方法、80 题分类、12×3 网格、各档开销 |

## 复现

预测均在各题 `end_time` 之前、以 `as-of = 2026-08-17T19:14:57+08:00` 冻结的信息做出。

```bash
# 在 predict-raven（分支 codex/futurex-raven-adapter）中：
npx tsx scripts/forecast/futurex.ts \
  --questions <raven-gonna-test>/runtime-artifacts/futurex/2026-08-19/questions.json \
  --revision 2841bff13f6d2f679298ce7007e91ae585f4ade1 \
  --as-of 2026-08-17T19:14:57+08:00 \
  --binary-all --profile <urd|verdandi|skuld> --run-id futurex-20260817T191457 \
  --artifact-root runtime-artifacts/futurex-adapter --allow-paid
```

逐题完整状态与推理报告留在 predict-raven 的
`runtime-artifacts/futurex-adapter/futurex-20260817T191457/<档位>/<题目 ID>/`（未入库）。
