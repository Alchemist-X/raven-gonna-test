# raven-gonna-test 开发计划

## Goal

- 建立一个与 `predict-raven` 交易仓库完全隔离的预测 benchmark 系统。
- 以统一 Predictor 核心参加 FutureX、ForecastBench 和 Prophet Arena。
- 先保证输出合法、完整、可恢复、可回测，再优化 leaderboard 分数。

## Outcome

基础版本已经能拉取官方题集、运行或 fallback、导出三种协议、严格验证、离线评分，并提供 Prophet raw endpoint。

范围边界：不自动提交、不发送邮件、不上传 GCS、不进行 onboarding、不包含资金或交易执行。外部账号、付费模型和公开部署必须经过人工授权。

## Implementation

### P0：已完成的基础版本

- [x] pnpm/TypeScript/Vitest workspace 与独立 Git 仓库。
- [x] 六类 task/result/evidence/policy contracts。
- [x] OpenAI-compatible/Foresight v4 client。
- [x] independent trials、logit aggregation、prior shrinkage、Platt calibration。
- [x] baseline-first、timeout、AbortSignal、并发、checkpoint、hash manifest。
- [x] FutureX fetch/route/run/export/validate/score。
- [x] FutureX inventory、显式 route-review gate、ID 子集 pilot、research snapshot validator 与 per-task end-time gate。
- [x] ForecastBench fetch/expand/run/export/coverage/raw score/source baselines。
- [x] Prophet current/legacy normalize、market prior、bounded residual、geometry、HTTP service。
- [x] 禁交易依赖和 core boundary gate。
- [x] 双语文档、fixtures、unit/integration/CLI smoke tests。

### P0.5：首次正式参赛前的运营 Gate

1. 确认 Predictor 是否为 `foresight-v4`，准备 API key、费用上限和 rate-limit 策略。
2. 完成 FutureX/ForecastBench 外部邮件注册和规则确认。
3. 确定 organization/model/model-organization 的不可变命名。
4. 部署 Prophet HTTPS endpoint，做真实 compatibility/load/timeout 验收。
5. 用最近历史整轮运行，测量成本、时延、fallback 率、覆盖和本地分数。
6. 为 FutureX 低置信路由建立按 round SHA 绑定的 override 文件。

验收：三榜均有 100% 本地合法 artifact；Prophet public endpoint 连续 24 小时无 5xx；没有任何 post-cutoff evidence。

### P1：冲分能力

1. ForecastBench source specialists：
   - DBnomics 日历季节 KNN 与天气短期融合；
   - FRED trend/random-walk/mean-reversion regime；
   - YFinance random walk + 弱 drift；
   - ACLED/Wikipedia 模板历史先验重估。
2. Market price connectors：只读、allowlist、保留 snapshot/as-of，不含任何交易方法。
3. 3–5 trial structured belief state，记录支持/反对证据、open questions 与分歧。
4. `source × subtype × horizon` 的 rolling/leave-one-round-out calibration。
5. FutureX domain specialists：选举/体育/宏观/金融/天气/娱乐；multi-label expected-F1 阈值；numeric nowcast。
6. Prophet residual registry：`category × subtype × time-to-close × price bin`，evidence gate 与 shadow deployment。
7. Adaptive compute：先全量 baseline，再按 score marginal value × uncertainty 分配深研预算。

验收：历史时间截断 backtest 相对安全基线显著改善；fallback <2%；校准参数只用更早轮次拟合。

### P2：稳定运营与可复现性

1. Calibration/model/strategy registry 与版本签名。
2. 完整历史 replay、round comparison、分层 ECE/Brier/Edge dashboard。
3. Provider rate-limit queue、指数退避、成本预算和 kill switch。
4. Prophet 容器、TLS、metrics、alerts、canary 和滚动更新。
5. Submission receipt/hash 跟踪和赛前自动检查报告。
6. 每轮结束的 resolution ingest、postmortem 与参数升级 Gate。

验收：任意 artifact 能从 manifest 重现；服务故障自动回市场 prior；外部提交仍需要明确人工确认。

## User Decisions

- Decision：Predictor 的准确 model ID。
  - Why it matters：决定 API 扩展、费用、rate limit 和 parser。
  - Recommended default：若无其他模型，使用 `foresight-v4`。
- Decision：参赛 organization/model 命名。
  - Why it matters：ForecastBench 发布后 model 名不可随意改，Prophet resubmit 会替换 active 版本。
  - Recommended default：产品名统一为 `raven-gonna-test`，底模进入 manifest，不进入每周随机名称。
- Decision：Prophet 托管环境。
  - Why it matters：需要 HTTPS、长请求、稳定并发和 secrets。
  - Recommended default：长期运行容器/VM，不使用短超时 serverless。
- Decision：每轮模型与研究费用上限。
  - Why it matters：决定 trials、research sources 和 adaptive compute。
  - Recommended default：先用历史整轮测量后再批准 live cap。

## Risks and Assumptions

- FutureX production scorer、numeric sigma、重提规则仍有漂移。
- ForecastBench 下一轮日期需官方回信确认，difficulty-adjusted scorer 需要额外官方数据。
- Prophet current raw contract、旧 rules 和 Top-K normalization 仍有冲突。
- Safety baselines 可保覆盖但不是冠军模型；必须以时间截断 backtest 证明升级。
- 没有真实 key 时无法验证 Foresight 成本、延迟和整轮解析成功率。

## Execution Gate

- 基础代码已经实现并通过本地验收。
- P0.5 的外部注册、付费整轮和公网部署需要用户提供账号/secret/预算或明确授权。
- P1/P2 可继续本地开发，但任何外部提交、公开部署或付费大批量运行前必须再次确认。
