# 三个 Benchmark 操作手册

核验时点：2026-08-09，新加坡时间。规则可能漂移；每轮运行前重新检查官方来源。

本文件是规则与时序摘要；可复制命令、阶段 Gate、产物、恢复和 Definition of Done 见 [三个 Benchmark 端到端执行 Runbook](three-benchmark-runbook.md)。

## FutureX

官方入口：[官网](https://futurex.live/)、[Online 数据集](https://huggingface.co/datasets/futurex-ai/Futurex-Online)、[公开 scorer](https://github.com/Futurex-ai/Futurex-Eval)。

当前 SHA `b7457c4d4229458767c666be72435c3afe45b0fd` 对应 8/5–8/11 事件，但提交截止已经在 8 月 5 日过去，不能补交。下一轮必须等官方 SHA/README 更新。

此 SHA 在截止后只能用于明确标记的 shadow/pilot。即使题目尚未结算，也不能把现在获得的额外信息冒充 8 月 5 日前的正式预测；pilot 必须保持 `submissionEligible=false`。

### 还需人工完成

1. 发信 `FutureX-ai@outlook.com`，确认下一轮 deadline、重提覆盖、ensemble/人工 review 和 production numeric scorer。
2. `futurex discover` 查看新 revision，再显式 `fetch --revision <full SHA>`。
3. 对低置信题型准备绑定该 SHA 的 route override。
4. Raven adapter 完成后运行 Raven、检查 checkpoint、生成 JSONL；当前 paid path 阻断。
5. strict validate；邮件正文写 model、framework、organization、dataset SHA、visibility。
6. 人工发送附件，保存 sent time、附件 hash 和回执。

### 提交时序

- T−4h：完整合法基线；
- T−2h：只刷新高波动/高边际价值题；
- T−75m：冻结和验证；
- T−60m：发邮件。

不要在最后一小时才第一次跑全量；邮件回执和重提规则没有充分保障。

## ForecastBench

官方入口：[提交 Wiki](https://github.com/forecastingresearch/forecastbench/wiki/How-to-submit-to-ForecastBench)、[题集](https://github.com/forecastingresearch/forecastbench-datasets/tree/main/datasets/question_sets)、[方法报告](https://www.forecastbench.org/assets/pdfs/forecastbench_updated_methodology.pdf)。

按双周 cadence 推定下一轮为 2026-08-16：UTC 00:00–23:59:59，即新加坡 8/16 08:00–8/17 07:59:59。日期尚需以官方回信为准。

### 还需人工完成

1. 立即发信 `forecastbench@forecastingresearch.org`：Google 邮箱、organization/匿名、website、方形 SVG logo。
2. 收到 GCS folder 和正式日期后先上传测试文件。
3. 确认组合系统的 model 字段使用产品名还是 `ensemble`。
4. 轮次开始后下载 dated question set；不要使用 `latest`。
5. 先生成 100% safety baseline；Raven adapter 与原题级 batching 完成后，再跑 Raven/统计专家覆盖。
6. 验证 market/dataset 各自覆盖、动态 horizon、范围、唯一键；文件名严格使用 `<forecast_due_date>.<organization>.<N>.json`。
7. 人工上传 GCS，检查 object timestamp/hash；失败时截止前邮件 fallback。

### 提交时序

- T−6h：全量基线完成；
- T−4h：文件首次完全合法；
- T−4h 至 T−2h：更新 market price 与失败题；
- T−90m：正式上传；
- T−60m：核验 GCS；
- T−30m：需要时邮件 fallback。

24 小时窗口后段的实时市场信息可能有帮助，但主要增益来自校准和 source-specific 模型，不值得用最后五分钟换可靠性。

## Prophet Arena

正式名称是 [Prophet Arena](https://www.prophetarena.co/)，不是 Profit Arena。入口：[Onboarding](https://www.prophetarena.co/onboarding)、[Agent 规则](https://www.prophetarena.co/research/agent-leaderboard-rules)、[最新评分](https://www.prophetarena.co/research/how-scoring-works)。

它没有周度文件截止。提交的是长期可调用的 HTTPS endpoint；新 agent 的公开资格存在“10 active days”与 UI “50 resolved events”的文档冲突。

### 还需人工完成

1. 决定用 Agent/raw endpoint track。
2. 选择长期运行、支持长请求的托管环境并配置 HTTPS。
3. 生成 32+ byte Bearer token；模型 key 只进入托管 secrets。
4. 运行 public health/auth/load smoke test。
5. 通过 Onboarding compatibility test，提交 display name、organization、logo URL、邮箱。
6. 发信 `contact@prophetarena.co` 确认 HTTP timeout/retry/concurrency、raw rationale、Top-K geometry 和公开资格。
7. 审核后保持 24/7，至少覆盖十天；resubmit 前先 shadow/canary，避免替换稳定版本。

收到事件后及时回答，不要故意耗尽 3,600 秒。主指标是 matched-market `Edge over Market`；市场本身也会更新，拖延不会自动创造 edge。

## 截止时间原则

“越晚越好”只在新增信息确实提高预测时成立。通用做法是：

```text
完整基线 → 深度研究 → 临近截止刷新高波动题
        → 冻结 → strict validate → 留出传输与回执缓冲
```

所有证据保存 `as_of`；截止后信息只能进入明确标记的 backtest，绝不能回流正式 submission candidate。
