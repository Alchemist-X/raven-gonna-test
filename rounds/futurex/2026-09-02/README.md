# FutureX 2026-09-02 · submission candidate

最后更新：2026-09-02 21:00 (UTC+8)　　英文版见 [`README.en.md`](README.en.md)

> **尚未提交。** FutureX 没有提交 API，只接受发往 `FutureX-ai@outlook.com` 的邮件，
> 本仓库没有任何命令能对外发送。这里存的是等待人工确认的候选件；邮件正文见
> [`email-opus.txt`](email-opus.txt)。

## 这是什么

本轮**在本地（macOS 开发机）**用 `raven-gonna-test` 完整跑了 `claude-opus-5`，
harness 与 2026-08-26 轮的服务器正式跑一致（`claude-cli` provider，上下文隔离，按 level 配 trial），
另加本轮新增的四处修正（见下文「本轮 harness 改动」）。

| 项 | 值 |
| --- | --- |
| 模型 | `claude-opus-5`（provider `claude-cli`，走 Claude Max 订阅） |
| 检索 effort | high（trial 上限 4，按 level 1/2/3/4 分配） |
| 证据冻结 as-of | `2026-09-02T08:26:26Z` |
| 提交截止 | 2026-09-02 24:00 (UTC+8) = `2026-09-02T16:00:00Z` |
| 题库版本 | `c8fcda646d7186ffcdff745b10862a116f9df36e`（75 题：L1 20 / L2 20 / L3 20 / L4 15） |
| 提交件 sha256 | `beb2ad3d8f7b662dd93e7a46fc6426d19839bd628f27b9b69078d9fe7926f459`（零联网变体 `submission-opus.no-web-variant.jsonl`：`cf85bca1…`） |
| 校验 | `valid: true`，coverage 1.0，0 error，0 warning |
| 兜底答案 | 0（4 道开工前已结算的题按用户决定联网查已公布结果，见下） |
| 题型分布 | single_choice 40 / numeric 19 / ranking 12 / open_text 4 |
| 生成代码 | 首跑 `797056c`，补跑 `866c0a5`，重推导 `d2b86a1`，已结算题联网查证 `ea3b0e1`（manifest `codeSha` 链） |

## 检索深度

| Level | 题数 | trials | 平均搜索/trial | 平均来源 URL/trial |
| --- | --- | --- | --- | --- |
| L1 | 20 | 24 | 5.6 | 33.3 |
| L2 | 20 | 42 | 5.0 | 30.8 |
| L3 | 20 | 59 | 7.2 | 37.7 |
| L4 | 15 | 56 | 11.1 | 73.3 |

合计 181 个 trial、1,391 次搜索、8,426 个来源 URL；账面 API 等价成本约 $166（实走订阅）。
零检索题 **2**（两道 MLB 单场总得分题，模型自判「结果不可知」按基率答 9 / 8，三个 trial 一致）。

## 本轮特殊处理（都有留痕）

1. **4 道题在开工前已过 end_time**（韩国 8 月 CPI、上议院 regret amendment、RBNZ OCR、澳洲 Q2 GDP）。
   主跑按规则不检索、走确定性兜底（等概率选 A）。**用户 22:05 决定：这类题直接联网查已公布的结果。**
   harness 新增 `futurex run --closed-questions research`（默认仍是 fallback），已结算题脚本新增 `--mode research`：
   给模型正常检索工具并明示「该事件结算时点已过，去找官方公布值，没公布再照常预测」，3 trial，
   再由 `futurex-splice-answers.mjs` 拼回。结果：韩国 8 月 CPI 3.1%→A、RBNZ 加息至 2.75%→B、澳洲 Q2 GDP +0.4%→C；
   上议院 regret amendment 的辩论排在 9 月 3 日、结算时点前尚未投票，opus 答 B（否决）、fable 答 C（NO_OFFICIAL_RESULT）。
   此前的零联网变体（凭训练知识作答：B/B/A/C）保留为 `submission-*.no-web-variant.jsonl`；两版的 trial 记录都在
   `submission-*.closed-research.json` / `submission-*.closed-no-web.json`，manifest `splicedRows` 记录替换前后值。
2. **路由人工覆盖 10 条。** 合并后的检测器把「谁赢 Vuelta 第 11/12 赛段」「Dragon Award 最佳数字游戏」
   「YouTube 全球周榜 No.1 MV」误判成 numeric，把 F1 领奖台 / F2、F3 冲刺赛前五 / 欧洲大师赛前五 /
   WTT 四强 / 苏格兰五个 NHS board 误判成 numeric（无 "top N" 措辞）。逐条改为 open_text / ranking，
   `routes.json` 里 `review.status=edited` 并带 notes；其余 65 条 approved。四个独立审核 agent + 两个反驳
   agent 复核了全部 75 条（[`route-audit-summary.txt`](route-audit-summary.txt)），唯一异议是 BEA 贸易逆差的
   正负号约定，属预测层而非路由，未改。
3. **首跑末段 13 个 trial 被 `403 Request not allowed` 瞬时错误和 900 s 超时吃掉**（12 并发）。
   trial 损失过半的 4 题（日本家庭消费支出 0/3、日本经常账户 1/3、Box Office Mojo 周末前五 1/4、
   YouTube 美国周榜前五 2/4）用 `futurex-checkpoint-drop.mjs` 从 checkpoint 剔除后 `--resume` 重新预测；
   备份在 `submission.jsonl.checkpoint.first-pass.json`。剩余 3 题保留 2/3–3/4 的 trial。
4. **排序题聚合修正后重推导 2 行。** Borda 把 `Somna med Humlan Djojj` 的两种大小写当成两个实体，
   瑞典专辑榜答案出现重复实体（官方判 0）。修正为大小写归一 + 「多数 trial 完全一致的顺序优先」，
   用 `futurex-reaggregate.mjs` 从既有 trial 重新推导（不重新检索）：专辑榜、单曲榜各改 1 行，
   manifest `reaggregated.changed` 记录前后值。

## 本轮 harness 改动（均已 commit，`pnpm verify` 213 测试通过）

- 题面「Report the value in X.」解析成 task unit，prompt 明示量纲（`USD billion`、`JPY 100 million`…）；
  计数单位（patients/kits/reports…）和「total runs」强制整数答案。
- 排序题序列化去掉实体内逗号（官方 extractor 按逗号切分且不解析 CSV 引号）。
- open_text 散文检查：冒号后需含数字才判为散文（`Hollow Knight: Silksong` 曾被误拒并阻断整份提交）。
- `403 Request not allowed` 纳入有界重试。
- 新脚本：`futurex-closed-no-web.mjs`、`futurex-splice-answers.mjs`、`futurex-checkpoint-drop.mjs`、
  `futurex-reaggregate.mjs`、`futurex-round-stats.mjs`。

## 文件

| 文件 | 说明 |
| --- | --- |
| `submission-opus.jsonl` | 官方格式 `{id, prediction}`，75 行 —— 提交时的附件就是这个 |
| `email-opus.txt` | 邮件正文（收件人、CC、主题、哈希已填好） |
| `submission-opus.jsonl.manifest.json` | 出处链：原始跑 → 拼合零联网作答 → 排序重推导；sha256、校验报告 |
| `submission-opus.reasoning.jsonl` | 每题每 trial 的 persona / 搜索词 / 来源 URL / 原始回复 / token；含 derivation |
| `submission-opus.review.html` | 浏览器评审页，按分数权重排序并标出待复核项 |
| `submission-opus.stats.json` / `.audit.json` | 分 level 检索深度、零检索题、usage 合计 |
| `submission-opus.closed-research.json` / `.closed-no-web.json` | 4 道已结算题的联网查证记录 / 零联网作答记录 |
| `submission-opus.no-web-variant.jsonl` (+manifest) | 已结算题按零联网作答的旧变体，仅存档 |
| `submission-opus.run-metadata.json` | 启动参数（模型、并发、effort、as-of、code SHA、主机） |
| `routes.json` (+manifest) | 本轮路由，75/75 已 review（10 edited、65 approved） |
| `questions.json.manifest.json` | 题库文件 hash（parquet sha256 `fd378ac6…`） |
| `route-audit-summary.txt` | 路由对抗审核结论 |

## 复现

```bash
# 取题、路由（路由文件已在本目录，含人工覆盖）
pnpm cli futurex fetch --revision c8fcda646d7186ffcdff745b10862a116f9df36e --output runtime-artifacts/futurex/2026-09-02/questions.json

PREDICTOR_PROVIDER=claude-cli PREDICTOR_MODEL=claude-opus-5 PREDICTOR_TRIALS=4 PREDICTOR_CONCURRENCY=12 \
PREDICTOR_REASONING_EFFORT=high PREDICTOR_TIMEOUT_MS=900000 PREDICTOR_MAX_RETRIES=2 \
node apps/benchmark-cli/dist/main.js futurex run \
  --input runtime-artifacts/futurex/2026-09-02/questions.json \
  --routes rounds/futurex/2026-09-02/routes.json \
  --revision c8fcda646d7186ffcdff745b10862a116f9df36e --round 2026-09-02 \
  --as-of 2026-09-02T08:26:26Z --deadline 2026-09-02T16:00:00Z \
  --output <out>/submission.jsonl --allow-paid

# 已结算题零联网作答 → 拼回 → 排序重推导 → 评审页
node scripts/futurex-closed-no-web.mjs ... --ids <4 ids> --output <out>/closed-no-web.json --allow-paid
node scripts/futurex-splice-answers.mjs --round-dir <round> --submission <out>/submission.jsonl --closed <out>/closed-no-web.json --output <out>/submission-final.jsonl
node scripts/futurex-reaggregate.mjs --round-dir <round> --submission <out>/submission-final.jsonl --output <out>/submission-release.jsonl --kinds ranking --reason "..."
node scripts/futurex-review-page.mjs <round> <out>/submission-release.jsonl
```

## 人工判断记录

1. **贸易逆差正负号（`baf399b4`）**：题面问 "deficit"、单位 USD billion，按 BEA 头条口径提交正数。
   未加代码层钳制；若官方真值记为负数则该题 0 分。
2. **两道 MLB 总得分题零检索**：接受模型的基率作答（9、8），未强制重跑——单场总得分检索边际价值低。
3. **fable-5 第二候选**：见下节。两个模型在 55/75 题上一致（数值按 5% 容差），20 题不同（权重 0.375），
   分歧集中在 L4 排序题（12 道里 10 道至少一个位置不同）和体育/榜单类；宏观数据题基本一致。已结算题联网查证后两模型在上议院题上分歧（B vs C），一致题数变为 54/75。

## 第二候选：claude-fable-5

opus 跑完后追加启动（as-of `2026-09-02T09:23:20Z`，并发 8）。第 29 题起订阅会话额度耗尽
（"session limit · resets 8:50pm"），46 题全 trial 失败；20:52 额度重置后 `--resume --retry-fallbacks`
补跑至 `2026-09-02T13:35:11Z` 完成。**检索时间窗因此是 09:23Z–13:35Z**，但每题检索都在其自身
end_time 前一分钟被硬性截断（batch 的 per-task cutoff），没有题目在结算后被检索；邮件正文如实写了这个窗口。

| 项 | 值 |
| --- | --- |
| 提交件 | `submission-fable.jsonl`，sha256 `1e3860fa96bb3e92bfd713b7536b6a6990964df78cc8f4303310f03b11e8f1e4`（零联网变体 `submission-fable.no-web-variant.jsonl`：`25519f96…`） |
| 校验 | valid，75/75，0 fallback，0 零检索（4 道已结算题联网查已公布结果：A/C/B/C） |
| trials | 184（L1 24 / L2 42 / L3 59 / L4 59），1,038 次搜索，6,466 来源 URL；trial 损失 2（额度限制） |
| 排序重推导 | 4 行改动（两道瑞典榜单存在大小写重复实体，修正后消除） |
| 邮件正文 | `email-fable.txt` |
| 其余文件 | `submission-fable.{jsonl.manifest.json,reasoning.jsonl,review.html,stats.json,audit.json,closed-no-web.json,run-metadata.json}` |
