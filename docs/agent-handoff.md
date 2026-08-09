# 下次开发接力

最后更新：2026-08-09 17:25 SGT

## 当前可用状态

- 仓库：`/Users/Aincrad/dev-proj/raven-gonna-test`，独立 Git 仓库，当前 `main` 尚无 commit。
- 本地验收：`pnpm verify` 全绿；边界检查、TypeScript 和 29 个测试全部通过。
- FutureX 只读实测：当前固定 SHA 成功下载 84 题；自动路由得到 47 single、1 multi、18 numeric、8 ranking、10 open，正式运行前必须人工复核 route artifact。
- ForecastBench 只读实测：当前官方 500 题动态展开为 2,248 条预测行；baseline candidate 的 market 250/250、dataset 1,998/1,998，覆盖率均为 100%。
- Prophet Arena：current/legacy 本地请求和 baseline response 已通过；公网 HTTPS 尚未部署。
- 未调用付费 Predictor，未发送邮件、上传 GCS、执行 onboarding 或外部提交。

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

1. 确认用户说的 Predictor 是否为 `foresight-v4`；若不是，记录准确 model ID、base URL 和响应格式。
2. 确认单轮费用上限、organization/model 命名和 Prophet 托管环境。
3. 用历史题集做第一次显式 `--allow-paid` 整轮回放，记录成本、P50/P95 时延、parse/fallback 率、覆盖率和本地分数；不得使用已知答案或当前网页形成预测。
4. 根据回放失败项补 FutureX 的 round-SHA-bound route overrides，并把稳定 override 固化为 fixture。
5. 完成下方三个 benchmark 的人工准入事项，再考虑正式 live candidate。

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
5. 3–5 个结构化独立 trial，显式记录支持证据、反证、open questions 和模型分歧。
6. Prophet residual registry、evidence gate、shadow evaluation 和 category/time-to-close calibration。
7. Adaptive compute：先保证全量 baseline，再按预期得分边际 × uncertainty 分配研究预算。

这些能力尚未实现，因此当前版本能合法、完整地跑三榜，但没有冠军级分数证据。

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
- Predictor 失败可以使用 deterministic baseline，但 manifest 必须明确记录 fallback。

更完整的阶段验收与用户决策见 [开发计划](../Plan/2026-08-09-raven-gonna-test-development-plan.md)。
