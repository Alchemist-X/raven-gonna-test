# FutureX 2026-09-09：题目配置

[English](README.en.md)。模式：`configuration-only`。这里只准备题目与路由，没有生成或提交预测。

题目固定为官方 revision `30c9fba49e4b37b12db857714a0b6884d80c6cfa`，共 80 题。原始公开题面见 [questions.json](questions.json)，下载来源与哈希见 [questions.json.manifest.json](questions.json.manifest.json)。按用户要求由 Codex 复核题型、输出基数和单位，记录在 [routes.json](routes.json)；审阅时间、政策、哈希及 16 处路由修正见 [preparation.json](preparation.json)。这些是配置审阅记录，不代表人类已发送提交。

最终为 40 道单选、21 道数值、14 道排序、3 道单实体文本和 2 道无序标识符集合。21 道数值题均有 `targetField / definition / unit / scale`；仅题面提供的单位或显式计数含义用来定义口径，没有读取本周结算答案。GBP/CAD/USD/JPY、桶和时间允许预先登记的乘法换算；摄氏温度只接受摄氏单位。

修正包括：EIA 本周问的是库存**变化**且单位为百万桶；财政收支余额按收入减支出保留符号；日本 M3 问平均余额水平；各项同比、比例、人数及合计得分分别定义。赛车与运动员 first-through 排名保留名次数量；YouTube 留榜数量题保留 A–E 选项；歌曲和太阳耀斑等级按文本回答。CVE/NCT 按完整标识符集合输出，逐位匹配、去重并排序，使用整个集合投票；空集序列化为 `[]`。这定义了本地输出格式，不声称已验证主办方对空集的具体评分行为。

整轮回归使用模拟模型覆盖 80/80 题，通过真实解析、聚合和 strict validator；模拟值只在测试内存中使用，不写候选文件。实际预测仍需独立运行、真实证据与完整验证。部分题目在配置准备时已经结束，沿用每题 `asOfUtc`、InformationPolicy 与现有 closed-question 策略；不能把现在检索到的答案当作此前的预测。

```bash
pnpm cli futurex inspect --input rounds/futurex/2026-09-09/questions.json --routes rounds/futurex/2026-09-09/routes.json --as-of 2026-09-09T00:00:00Z
pnpm verify
```

数值合同格式见 [说明](../../../docs/futurex-numeric-contract.md)。以上 `as-of` 仅演示查看配置；真实运行必须传入真实证据截止时间。
