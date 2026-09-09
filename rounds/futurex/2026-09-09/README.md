# FutureX 2026-09-09 · submission candidate（claude-fable-5-1, max effort）

最后更新：2026-09-09 23:55 (UTC+8)　　英文版见 [`README.en.md`](README.en.md)

> **由人工发送。** FutureX 只接受发往 `FutureX-ai@outlook.com` 的邮件；邮件正文见 [`email-fable51.txt`](email-fable51.txt)，
> 记录见 [`SUBMISSIONS.json`](SUBMISSIONS.json)。本轮是**限时 50 分钟**的一次跑，结果不完整，下面如实记录每一行答案的来源。

| 项 | 值 |
| --- | --- |
| 模型 | `claude-fable-5-1`（provider `claude-cli`，`--effort max`，Claude Max 订阅） |
| 题库版本 | `30c9fba49e4b37b12db857714a0b6884d80c6cfa`（80 题：L1/L2/L3/L4 各 20），配置与路由见下节 |
| 证据冻结 as-of | `2026-09-09T15:03:16Z`；检索窗口至 `2026-09-09T15:45:58Z`（定稿） |
| 提交截止 | 2026-09-09 24:00 (UTC+8) = `2026-09-09T16:00:00Z` |
| 提交件 sha256 | `55c7b0a9df56f400af867fb2d01da428f03a438bf51475b4f881ff8a8ac607cd` |
| 校验 | strict validator `valid: true`，coverage 1.0，0 error，0 warning |
| 答案来源 | harness 29 / 拼接 23 / 确定性兜底 28（见下表） |

## 答案来源（逐级）

| Level | harness（fable 5.1 + 检索） | 拼接 | 兜底 | 题型 |
| --- | --- | --- | --- | --- |
| L1 | 14 | 6 | 0 | single_choice 20 |
| L2 | 7 | 13 | 0 | single_choice 20 |
| L3 | 5 | 2 | 13 | numeric 17 / open_text 3 |
| L4 | 3 | 2 | 15 | ranking 14 / numeric 4 / open_text 2 |

- **harness 29 题**：39 个 trial、4,354 个来源 URL（21 题 1 trial、6 题 2 trial、2 题 3 trial）。8 道开工前已过 end_time 的题按既定政策 `--closed-questions research` 联网查已公布结果（中国 8 月 CPI、马来西亚 IPI、法国制造业产出、日本 M3、新罕布什尔两党初选、ONS 肌骨等待就业份额、ONS 周登记死亡）。
- **拼接 23 题**（逐行记录在 [`submission-fable51.jsonl.splice-record.json`](submission-fable51.jsonl.splice-record.json) 与 [`submission-fable51.overrides.json`](submission-fable51.overrides.json)）：19 道 L1/L2 单选由两个 fable 5.1 检索子代理（Claude Code 会话内，每题 1–2 次搜索）作答；Spotify UK 周榜冠军按 kworb 当前榜（"Rein Me In" 蝉联）、耀斑等级按 SWPC 概率取 C 级；CVE/NCT 标识符集合无法预知取空集 `[]`。
- **兜底 28 题**：15 道 numeric、13 道 ranking，全部是 harness 没跑到的 L3/L4，按确定性兜底规则填写，预期得分≈0。

## 跑的经过（都有留痕）

1. **Huginn（raven-labs 服务器）主跑** 15:03Z 启动：24 并发、trial 上限 3（按 level 1/2/3/3）、单 trial 10 分钟超时。
   服务器 claude CLI 2.1.241 不支持 fable 5.1（需 ≥2.1.251），升级到 2.1.266 后可用；凭证为 `~yishu/forecast-fleet/env/.shared.env` 的共享 OAuth token。
   跑到 ~15:09Z 该 token 触发 `You've hit your session limit · resets 12:50am (Asia/Shanghai)`，其后所有新 trial 秒失败；已在途的 trial 陆续完成，最终 26 题有效（[`submission-fable51.huginn-checkpoint.json`](submission-fable51.huginn-checkpoint.json)）。
2. **本地 resume #1** 15:13Z：把 Huginn 有效结果作为 checkpoint（identity.trials 改为 1）在 macOS 上 `--resume`，16 并发。
   5 分钟后 64 个 trial 报 `Failed to authenticate. API Error: 403 Request not allowed`（账号级限流，重试 1s/2s 太短），只新增 1 题。
3. **本地 resume #2/#3** 15:26Z / 15:35Z：8 并发、重试退避 5–40s、超时 8→14 分钟。新增 9 题。发现 harness 按 `end_time` 而非 level 排队，L3/L4 大多排在队尾；第一波 6/8 个 trial 撞上 8 分钟超时；最后一波因会话中断在 15:43Z 被重启，定稿前未完成。
4. **定稿** 15:46Z：合并三份 checkpoint（同题取 trial 多者），仍为兜底的行按上表拼接，通过 strict validator 后生成提交件。

完整日志见 [`submission-fable51.local-run.log`](submission-fable51.local-run.log)；逐题 trial/引用/来源见 [`submission-fable51.reasoning.jsonl`](submission-fable51.reasoning.jsonl)；manifest 见 [`submission-fable51.jsonl.manifest.json`](submission-fable51.jsonl.manifest.json)（代码 Huginn 侧 `f7941fe`、本地 `c62f147`，两者运行代码相同）。

## 教训（下轮必须改）

- 单个 Claude Max token 撑不住一轮 max-effort 全量跑：Huginn 共享 token 约 50 个 max trial 就触顶；本地账号 16 并发即触发 403 限流，8 并发才稳。**至少提前 3 小时开跑，或准备多个独立账号分题跑。**
- harness 的任务顺序是 `end_time` 升序；限时情况下应先按 level 拆分输入文件（如本轮 run4 的做法），否则高权重的 L3/L4 排在最后。
- 跑到一半失败时 `futurex run` 不落提交件（numeric 兜底断言先抛错），本轮临时写的 `assemble-final.mjs`（从 checkpoint 合并拼装）值得收进 `scripts/`。

## 题目配置（Codex 复核，沿用）

题目固定为官方 revision `30c9fba49e4b37b12db857714a0b6884d80c6cfa`，共 80 题。原始公开题面见 [questions.json](questions.json)，下载来源与哈希见 [questions.json.manifest.json](questions.json.manifest.json)。题型、输出基数和单位由 Codex 复核，记录在 [routes.json](routes.json)；审阅时间、政策、哈希及 16 处路由修正见 [preparation.json](preparation.json)。最终为 40 道单选、21 道数值、14 道排序、3 道单实体文本和 2 道无序标识符集合；21 道数值题均有 `targetField / definition / unit / scale`。数值合同格式见 [说明](../../../docs/futurex-numeric-contract.md)。

```bash
pnpm cli futurex validate --input rounds/futurex/2026-09-09/questions.json --submission rounds/futurex/2026-09-09/submission-fable51.jsonl --routes rounds/futurex/2026-09-09/routes.json --deadline 2026-09-10T00:00:00+08:00
```
