# raven-gonna-test 项目规则

最后更新：2026-08-09

- 本仓库只做预测 benchmark 研究、生成、校验和离线评分；不得包含钱包、交易、下单或资金执行逻辑。
- 所有外部提交默认关闭。CLI 只能生成候选文件，邮件、GCS 上传和 Prophet Arena onboarding 必须由人类明确执行。
- `packages/forecast-core` 必须保持纯领域逻辑：不得读取 env、文件系统或网络，不得依赖具体 benchmark。
- 每个任务必须显式携带 `InformationPolicy` 和 `asOfUtc`；禁止用全局 market-blind 开关代替政策。
- 新增或修改面向人的 Markdown 时同步维护中文主文件与英文副本。
- 关键运行输出 execution mode、进度、最终 artifact 路径；失败不得静默 fallback。
- Predictor 或检索失败可以使用已声明的 deterministic fallback，但结果和 manifest 必须标记 `fallbackUsed`/原因。
- 正式候选必须达到 100% 本地覆盖并通过 strict validator，即使官方只要求 95%。

