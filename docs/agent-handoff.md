# 下次开发接力

最后更新：2026-08-09 23:24 SGT

## 当前可用状态

- 仓库：`/Users/Aincrad/dev-proj/raven-gonna-test`，公开 GitHub 仓库 `Alchemist-X/raven-gonna-test`；当前工作入口为 `main`。
- `codex/futurex-partial-research` 的独立 worktree 仍在 `/Users/Aincrad/dev-proj/raven-gonna-test-futurex-partial`，不要在两个 worktree 之间执行共享 checkout/reset。
- 本地验收：`pnpm verify` 全绿；边界检查、TypeScript 和 31 个测试全部通过。
- FutureX 只读实测：当前固定 SHA 成功下载 84 题；自动路由得到 47 single、1 multi、18 numeric、8 ranking、10 open，正式运行前必须人工复核 route artifact。
- ForecastBench 只读实测：当前官方 500 题动态展开为 2,248 条预测行；baseline candidate 的 market 250/250、dataset 1,998/1,998，覆盖率均为 100%。
- Prophet Arena：current/legacy 本地请求和 baseline response 已通过；公网 HTTPS 尚未部署。
- 用户已明确选择自研 **Raven Forecasting Engine** 作为三榜唯一正式预测系统，不使用第三方专用预测模型。
- 当前 `raven-gonna-test` 的 paid path 仍是 legacy OpenAI-compatible client；Raven adapter 尚未实现，因此所有 `--allow-paid`、Prophet live onboarding 和正式候选均被流程阻断。
- 未调用付费 Raven benchmark path，未发送邮件、上传 GCS、执行 onboarding 或外部提交。
- 新增详细双语执行文档：`docs/three-benchmark-runbook.md` / `docs/en/three-benchmark-runbook.md`。它区分已实现命令、人工动作和待开发能力，并覆盖 preflight、pilot、三榜完整命令、校验、提交、恢复、时间与费用 Gate。
- 本轮 Raven-only 文档修改仍在工作区，尚未 commit/push；下次先检查 `git status`，不要丢弃或覆盖。

本轮新增：

- `futurex inspect`：输出题型/Level/单题理论权重、题目 end-time 状态和 route-review 状态。
- 自动 route 保留 confidence/reasons，默认全部 `pending`；付费 pilot/正式 run 会在模型调用前阻断未 review 条目。
- `futurex pilot --ids ...`：只跑显式题目，逐题 checkpoint，输出固定 `submissionEligible=false`，并把 input/routes hash 纳入身份。
- `futurex research-validate`：校验部分人工/ensemble 研究快照、证据时间和预测格式，不降低正式提交的全量要求。
- 修正 3 个明显 numeric 误路由；当前语义题型为 single=47、multi=1、numeric=21、ranking=8、open=7。
- 已生成 10 题 shadow snapshot：`runtime-artifacts/futurex/shadow-2026-08-09/research-snapshot.json`，校验通过但明确不可提交。

运行产物在 `runtime-artifacts/`，默认被 Git 忽略；它们是 smoke evidence，不是长期 source of truth，可由固定输入重新生成。

## 下次首先做

```bash
cd /Users/Aincrad/dev-proj/raven-gonna-test
git status --short --branch
pnpm install
pnpm verify
pnpm doctor
```

然后依次完成：

1. 固定 `predict-raven` 完整 Git SHA，抽取纯 forecasting seam；严禁引用 `forecast:live` 等真钱交易路径。
2. 实现 Raven async REST adapter（POST start → GET poll），补齐 fixed resolution、task ID、as-of、per-job InformationPolicy、run/replicate namespace、exact provider/model 和完整 usage。
3. 实现六类 typed answers、ForecastBench 联合 horizons 和 Prophet 联合 outcomes；初期外层 replicate 固定为 1。
4. 给 `doctor`、checkpoint 和 manifest 增加 Raven engine/adapter SHA 与 readiness Gate；paid path 不得 fallback 到 legacy client。
5. 完成 3–10 题 Raven pilot，分别记录 framing/evidence/summary 调用、token/API/订阅/extra API 成本、P50/P95、parse/fallback 和 cutoff 违规。
6. 审核新轮全部 route，把 `pending` 显式改为 `approved/edited` 并填写 `reviewedAtUtc`；把稳定修正固化为 fixture。
7. 完成下方三个 benchmark 的人工准入事项，再考虑正式 live candidate。

## 尚未完成：人工与外部依赖

### FutureX

- 等待并确认下一轮正式 dataset SHA、window 和最早有效 deadline。
- 发信确认重提覆盖、ensemble/人工 review、production judge 和 numeric sigma。
- 新轮 route artifact 逐题检查低置信项；最终 JSONL 需要人工邮件发送并保存回执/hash。

### ForecastBench

- 向主办方注册 Google upload 邮箱、organization/匿名选项、website 和 SVG logo。
- 取得并测试 GCS folder，确认下一轮日期和稳定的 model 命名。
- 正式文件必须使用 `<forecast_due_date>.<organization>.<N>.json`，人工上传并核验 object timestamp/hash。
- 本地目前只有 raw Brier；官方 difficulty-adjusted 复现仍缺 question fixed effects/market reference data。

### Prophet Arena

- 选择长期运行的容器/VM，配置 HTTPS、32+ byte Bearer token 和 hosted secrets。
- 跑公网 health/auth/load/timeout smoke，随后通过 onboarding compatibility test。
- 向主办方确认 current/legacy wire、rationale、Top-K geometry、retry/concurrency 和公开榜资格。
- 做 24 小时稳定性验收，再持续运行至少十天；替换线上版本前先 shadow/canary。

## 尚未完成：冲分开发

按优先顺序：

1. 冻结历史证据 adapter：保存正文快照、抓取时刻、source hash 与 cutoff 校验；当前 citation URL 不能证明无未来信息泄漏。
2. ForecastBench source specialists：DBnomics 季节 KNN/天气融合、FRED regime、YFinance random walk、ACLED/Wikipedia 历史先验。
3. `source × subtype × horizon` 的 rolling/leave-one-round-out calibration，输出分层 Brier/ECE。
4. FutureX domain specialists、multi-label expected-F1 阈值和 numeric nowcast。
5. Raven 内部 rounds 与独立 replicates 分开；只有高价值题运行 3–5 个结构化 fresh replicates，并显式记录支持证据、反证、open questions 和模型分歧。
6. Prophet residual registry、evidence gate、shadow evaluation 和 category/time-to-close calibration。
7. Adaptive compute：先保证全量 baseline，再按预期得分边际 × uncertainty 分配研究预算。

这些能力尚未实现。当前版本能生成合法 baseline、完成下载/路由/校验/评分，但不能生成 Raven 正式候选；在 adapter Gate 通过前不得宣称三榜完整运行已完成。

## 尚未完成：稳定运营

- model/calibration/strategy registry 与版本签名。
- 完整历史 replay、round comparison 和 ECE/Brier/Edge dashboard。
- provider durable queue、成本预算/kill switch 和更完整的 rate-limit telemetry。
- Prophet 容器、TLS、metrics、alerts、canary 和滚动更新。
- submission receipt/hash 跟踪、赛前报告、resolution ingest 与每轮 postmortem。

## 不得跨越的边界

- 不加入钱包、签名、订单、交易 SDK 或资金逻辑。
- 不自动发送邮件、上传 GCS 或完成 onboarding；外部动作需用户明确授权。
- 付费调用必须显式 `--allow-paid`，并先确认预算。
- live candidate 不得使用 cutoff 后证据；live research 不能用于历史 backtest。
- Raven 失败可以使用 deterministic baseline，但 manifest 必须明确记录 fallback；不得把 baseline 标成 Raven 预测结果。

更完整的阶段验收与用户决策见 [开发计划](../Plan/2026-08-09-raven-gonna-test-development-plan.md)。
