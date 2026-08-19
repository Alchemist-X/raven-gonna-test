# FutureX 提交邮件格式

最后更新：2026-08-19　　英文版见 [`en/futurex-submission-email.md`](en/futurex-submission-email.md)

FutureX **没有提交 API**，只接受邮件（官方说明见其 HuggingFace 数据集页）。本仓库
也没有任何命令能对外发送——`futurex run` 只产出文件，发信是人工步骤。这份文档给出
实际发过的模板，照抄即可，不必每轮重新设计。

## 硬性要求（主办方规定）

- **附件只放官方 JSONL**，即 `{id, prediction}` 一行一题。推理链、manifest 一律不附，
  主办方要审计再单独提供。
- 收件人 `FutureX-ai@outlook.com`。
- 在该轮截止时间前送达（通常是轮次日期当天 24:00 UTC+8）。

## 正文要素

正文格式主办方没有规定，以下是本仓库的约定（runbook D7）。原则：**让主办方能唯一确定
这份提交是谁、用什么模型、对着哪一版题库做的**，并能验证附件未被损坏。

| 字段 | 说明 |
| --- | --- |
| Entry name | 上排行榜的名字。格式 `<org>/<model>`，例如 `raven_labs/claude-opus-5` |
| Organization | 机构名 |
| Model | 模型全名 + 是否联网检索 |
| Agent framework | 本仓库名 + **完整 commit SHA**，让结果可复现 |
| Dataset revision | 题库的 40 位 SHA，证明答的是哪一版题 |
| Coverage | `已答/总题数` |
| Evidence cutoff | 证据冻结时刻（`--as-of`），说明未使用该时刻之后的信息 |
| Attachment SHA-256 | 附件哈希，防传输损坏或篡改 |
| Visibility | 是否同意公开上榜 |

**Entry name 用模型真名，不要用内部代号。** 排行榜条目会被读作「谁用了哪个模型」，
代号会让外人无从对照。

## 模板

> **To:** FutureX-ai@outlook.com
> **CC:** issue.00.gui@gmail.com, millank0817@gmail.com, 1700012744@pku.edu.cn
> **Subject:** FutureX submission — round `<ROUND>` — `<ENTRY_NAME>`
> **附件:** `<submission>.jsonl`

```text
Hello FutureX team,

Please find attached our submission for the <ROUND> round.

- Entry name: <ENTRY_NAME>
- Organization: <ORG>
- Model: <MODEL> (<VENDOR>), with live web research
- Agent framework: raven-gonna-test, commit <FULL_COMMIT_SHA> (github.com/Alchemist-X/raven-gonna-test)
- Dataset revision: <DATASET_SHA_40>
- Coverage: <N>/<TOTAL> questions
- Evidence cutoff: all answers were produced with research frozen at <ISO8601>, before every question's end time
- Attachment SHA-256: <SHA256>
- Visibility: public — fine to list on the leaderboard

Per-question reasoning traces and provenance manifests are archived in the repository above and available on request.

Best regards,
<ORG>
```

## 已发实例（2026-08-19 轮）

三份提交共用同一 harness、同一 prompt、同一证据截止，**唯一变量是模型**——这样横向
比较才是模型对照，而不是脚手架对照。

> **To:** FutureX-ai@outlook.com
> **CC:** issue.00.gui@gmail.com, millank0817@gmail.com, 1700012744@pku.edu.cn
> **Subject:** FutureX submission — round 2026-08-19 — raven_labs/claude-opus-5
> **附件:** `submission-opus.jsonl`

```text
Hello FutureX team,

Please find attached our submission for the 2026-08-19 round.

- Entry name: raven_labs/claude-opus-5
- Organization: raven_labs
- Model: claude-opus-5 (Anthropic), with live web research
- Agent framework: raven-gonna-test, commit 9cfa3e31aac7c9ed9b14d80884379837b760ae4a (github.com/Alchemist-X/raven-gonna-test)
- Dataset revision: 2841bff13f6d2f679298ce7007e91ae585f4ade1
- Coverage: 80/80 questions
- Evidence cutoff: all answers were produced with research frozen at 2026-08-18T02:25:21Z, before every question's end time
- Attachment SHA-256: 4318d9c68cc8147d7ad986e419d4f93e16b5a5d315738c8b94cf41278937673a
- Visibility: public — fine to list on the leaderboard

Per-question reasoning traces and provenance manifests are archived in the repository above and available on request.

Best regards,
raven_labs
```

同轮另两份只改 Entry name、Model 与附件/哈希：`raven_labs/claude-sonnet-5`、
`raven_labs/claude-fable-5`。完整记录见
[`rounds/futurex/2026-08-19/SUBMISSIONS.json`](../rounds/futurex/2026-08-19/SUBMISSIONS.json)。

## 取值来源

```bash
# 附件哈希（必须是最终要发的那个文件）
shasum -a 256 rounds/futurex/<round>/submission-<model>.jsonl

# agent framework commit
git rev-parse HEAD

# dataset revision / evidence cutoff / coverage
python3 -c "import json;m=json.load(open('rounds/futurex/<round>/submission-<model>.jsonl.manifest.json'));print(m['revision'],m['evidenceCutoff'],m['records'])"
```

**改过提交件之后一定要重算哈希。** 本轮 HMRC 那题做过人工单位修正，哈希随之变了；
发出去的哈希若对不上附件，主办方无从判断是传输问题还是提交了别的文件。

## 发送后归档（runbook D7）

写入 `rounds/futurex/<round>/SUBMISSIONS.json`：发送时间、收件人与 CC、主题、附件
SHA-256、每份的已知瑕疵（例如某几题零检索、是否有人工修正）。**瑕疵要如实记**——
排行榜只给一个数字，能解释名次的只有这份记录。
