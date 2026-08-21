# raven-gonna-test

`raven-gonna-test` 是一个独立、无交易能力的预测 benchmark 工具仓库。它把通用概率预测核心与三个动态评测系统的协议隔离开来：

- [FutureX](https://futurex.live/)：多题型 point prediction，生成严格的 `{id,prediction}` JSONL。
- [ForecastBench](https://www.forecastbench.org/)：market + dataset 二元概率批处理，生成 GCS-ready JSON。
- [Prophet Arena](https://www.prophetarena.co/)：长期在线 raw forecasting endpoint，以 Kalshi 报价为先验做 bounded residual。

仓库不会发送邮件、上传 GCS、执行 onboarding、连接钱包或下单。所有命令只生成、校验或离线评分。

## 当前状态

截至 2026-08-09，首个可运行版本已经具备：

- 六类预测任务：binary、categorical、multi-label、ranking、numeric、free response；
- OpenAI-compatible Predictor 客户端，原生支持 Foresight v4 的 `answer_type`、`research` 和 `reasoning_effort`；
- 多次独立 trial、logit pooling、市场先验收缩、概率约束和 Platt calibration；
- 显式 `InformationPolicy`、证据截止时间与 market-data 隔离；
- FutureX 从 `/resolve/<SHA>/...parquet` 真正固定版本拉题并记录文件 hash，提供题型路由、JSONL 导出/校验和版本化本地 scorer；
- FutureX inventory、显式 route-review 状态、研究快照 validator，以及只跑指定 ID 且永不生成官方附件的 research-only pilot；
- ForecastBench 动态 horizon 展开、source safety baseline、100% coverage validator 和 raw Brier scorer；
- Prophet Arena current/legacy schema、双边 ask 中点先验、±5pp residual、几何投影、Bearer HTTP 服务；
- 可校验恢复的 checkpoint、默认禁止覆盖、付费显式确认、artifact hash、全局并发闸门、边界检查和离线 fixtures。

尚未用真实 Predictor API key 完成整轮付费预测，也没有进行任何外部提交。

## 快速开始

要求 Node.js 20+ 与 pnpm 10。

```bash
pnpm install
cp .env.example .env
pnpm verify
pnpm doctor
```

运行 live Predictor 前，在本地环境配置：

```bash
export PREDICTOR_API_KEY="..."
export PREDICTOR_MODEL="foresight-v4"
export PREDICTOR_BASE_URL="https://api.lightningrod.ai/v1/openai"
```

也可以走订阅制 CLI provider，不需要 `PREDICTOR_API_KEY`：

```bash
# Claude Code 订阅
export PREDICTOR_PROVIDER="claude-cli"
export PREDICTOR_MODEL="claude-sonnet-5"
export PREDICTOR_CLAUDE_EFFORT="high"     # 可选：low|medium|high|xhigh|max

# 或 OpenAI Codex CLI（ChatGPT 订阅）
export PREDICTOR_PROVIDER="codex-cli"
export PREDICTOR_MODEL="gpt-5.6-sol"
export PREDICTOR_CODEX_EFFORT="xhigh"     # 可选：low|medium|high|xhigh|max|ultra
```

codex-cli provider 的行为边界（均为实测结论，详见 `packages/runtime/src/codex-cli.ts` 头注）：

- 每次调用都在全新的 `CODEX_HOME`（仅链接 auth.json）里执行——`~/.codex` 的 AGENTS.md、config、plugins 和跨会话 memories 一律不进上下文；
- 该版本的 web_search 无法关闭，因此 `web: deny` 的任务会被**直接拒绝**（fail-closed），不会降级成"口头要求不搜"；
- `citations` 记录的是 `search://<query>` 检索查询而非真实抓取的 URL（事件流不暴露结果 URL），与 claude-cli 的 citation **不可直接对比**；
- 最终回复受 `--output-schema` JSON Schema 约束——解析失败率天然低于 claude-cli，这是 harness 差异而非模型差异，对比时必须注明。

不要把 key 写进提交文件、manifest、命令输出或 Git。

## 常用命令

### FutureX

```bash
# 只查看当前候选 revision；不会自动采用 main
pnpm cli futurex discover

# 必须显式固定完整 40 位 SHA
pnpm cli futurex fetch \
  --revision <40-char-sha> \
  --output runtime-artifacts/futurex/<round>/questions.json

# 先生成并人工审查；routes 文件与该 SHA 绑定
pnpm cli futurex route \
  --input runtime-artifacts/futurex/<round>/questions.json \
  --revision <40-char-sha> \
  --output runtime-artifacts/futurex/<round>/routes.json

# 查看题型、Level 权重、未到结算时点数量和 route-review 状态
pnpm cli futurex inspect \
  --input runtime-artifacts/futurex/<round>/questions.json \
  --routes runtime-artifacts/futurex/<round>/routes.json \
  --as-of <ISO-8601>

# route 命令生成的条目默认为 pending；逐题核对后才能改为 approved/edited，
# 并填写 reviewedAtUtc。正式 run 与付费 pilot 都会在调用模型前阻断 pending route。

# 仅研究指定 ID；输出包含完整 ForecastResult，且固定 submissionEligible=false
pnpm cli futurex pilot \
  --input runtime-artifacts/futurex/<round>/questions.json \
  --routes runtime-artifacts/futurex/<round>/routes.json \
  --revision <40-char-sha> \
  --round <round-id> \
  --as-of <ISO-8601> \
  --ids <id-1,id-2,id-3> \
  --output runtime-artifacts/futurex/<round>/pilot.json \
  --allow-paid

# 校验人工/ensemble 研究快照；允许部分覆盖，但永远不可作为提交附件
pnpm cli futurex research-validate \
  --input runtime-artifacts/futurex/<round>/questions.json \
  --routes runtime-artifacts/futurex/<round>/routes.json \
  --snapshot runtime-artifacts/futurex/<round>/research-snapshot.json \
  --revision <40-char-sha>

pnpm cli futurex run \
  --input runtime-artifacts/futurex/<round>/questions.json \
  --routes runtime-artifacts/futurex/<round>/routes.json \
  --revision <40-char-sha> \
  --round <round-id> \
  --as-of <ISO-8601> \
  --deadline <ISO-8601> \
  --output runtime-artifacts/futurex/<round>/submission.jsonl \
  --allow-paid

pnpm cli futurex validate \
  --input runtime-artifacts/futurex/<round>/questions.json \
  --submission runtime-artifacts/futurex/<round>/submission.jsonl \
  --deadline <ISO-8601>
```

当前 FutureX 没有官方提交 API。最终文件需要人工邮件发送。
`pilot` 和 research snapshot 与正式 submission candidate 是不同协议：它们固定写入 `submissionEligible=false`，并拒绝在 `as-of` 已达到题目 `end_time` 后继续 live research。

### ForecastBench

```bash
pnpm cli forecastbench fetch \
  --question-set 2026-08-16-llm.json \
  --output runtime-artifacts/forecastbench/2026-08-16/questions.json

# 不花模型费用的完整 plumbing/safety-baseline 演练
pnpm cli forecastbench run \
  --input runtime-artifacts/forecastbench/2026-08-16/questions.json \
  --output runtime-artifacts/forecastbench/2026-08-16/2026-08-16.Raven.1.json \
  --organization Raven \
  --model-name source-safety-baseline-v1 \
  --model-organization Raven \
  --baseline-only

# 去掉 --baseline-only、加 --allow-paid 才会调用 Predictor；可另传 --market-snapshot
pnpm cli forecastbench validate \
  --input runtime-artifacts/forecastbench/2026-08-16/questions.json \
  --submission runtime-artifacts/forecastbench/2026-08-16/2026-08-16.Raven.1.json
```

CLI 不上传 GCS。验证通过后仍需人工确认题集、组织名、模型名和文件名。

### Prophet Arena

```bash
# 单事件本地回放；baseline-only 只返回 market prior
pnpm cli prophet predict \
  --input fixtures/prophet-arena/current-request.json \
  --output runtime-artifacts/prophet/local-response.json \
  --baseline-only

# 长期 raw endpoint
export PROPHET_BEARER_TOKEN="<32+ byte random token>"
export PROPHET_HOST="0.0.0.0"
pnpm prophet:serve
```

服务提供：

- `GET /healthz`
- `POST /forecast`，也接受根路径 `POST /`
- 256 KB body limit、Bearer auth、并发上限、single-flight、market-prior fallback 和审计 artifact

服务默认只绑定 `127.0.0.1`；公网绑定必须有 32+ byte token，且缺 Predictor key 时拒绝启动（本地纯 baseline 必须显式 `PROPHET_ALLOW_BASELINE_ONLY=1`）。生产 onboarding 前还必须部署 HTTPS，并用 compatibility test 验收。

## 架构

```text
apps/benchmark-cli
apps/prophet-arena-api
        ↓
packages/benchmarks  packages/runtime  packages/eval
        ↓                  ↓                ↓
                packages/forecast-core
```

- `forecast-core` 不读取 env、网络或文件系统。
- `runtime` 实现模型 HTTP、并发和 artifact。
- `benchmarks` 只负责外部协议、路由、fallback、导出和校验。
- `eval` 负责 Brier、ECE、Edge-over-Market、Platt 和时间顺序切分。

详细说明见 [架构文档](docs/architecture.md)。参赛手续、时间窗口和最后时段策略见 [三榜操作手册](docs/benchmark-playbook.md)。下次直接从 [开发接力](docs/agent-handoff.md) 继续；完整阶段规划见 [开发计划](Plan/2026-08-09-raven-gonna-test-development-plan.md)。

## 验证

```bash
pnpm lint:boundaries
pnpm typecheck
pnpm test
pnpm verify
```

边界检查会阻止 core 读取环境/文件/HTTP，也会阻止加入交易 SDK、钱包变量和旧 Raven 交易依赖。

## 明确限制

- FutureX 的 production LLM judge 与 numeric sigma 存在官方文档漂移；本地 scorer 会明确标记近似或不可评分项。
- ForecastBench 本地 scorer 是 raw Brier，不冒充官方 difficulty-adjusted leaderboard score。
- ForecastBench 的 source baselines 是可追溯补洞策略，不是最终的 DBnomics/FRED 等统计模型。
- Prophet Arena 事件几何默认按 independent markets 保留，不会把 Top-K/独立市场错误归一化；exclusive/threshold 必须显式指定。
- 当前没有真实模型整轮成本、时延和分数证据，不能宣称已达到冠军水平。
- 结构化 `EvidenceRecord` 有硬校验，但厂商 research 目前只返回 citation URL，不能证明历史时点无泄漏；因此 CLI 已禁止使用 live research 做 backtest。
