# FutureX 数值目标与单位校验

英文副本：[English](en/futurex-numeric-contract.md)。2026-09-09 更新。

8 月 26 日回顾发现了千倍、百万倍的单位错误，以及把指数水平当成月度变化的目标错误。现在 `futurex run` 和 `futurex pilot` 要求每个数值 route 显式携带 `numericContract`；只有题目里的字段名或单位句还不够。先核对结算来源，再记录目标指标、参考期、初值/修订值、季调口径和输出单位，最后运行 `route-review`。不要用已公布答案调参或据此修改历史预测。

在现有、绑定完整 revision SHA 的 routes 文件中，为数值题补充如下结构。此例仅展示格式；实际定义必须对应当轮题目。

```json
{
  "kind": "numeric",
  "numericContract": {
    "targetField": "quarterly_total_revenue",
    "definition": "Total revenue for the fiscal quarter named in the question, from the issuer's first earnings release; not net income or a segment's revenue.",
    "unit": "USD million",
    "scale": "One output unit equals one million USD.",
    "example": { "sourceValue": "USD 2.7 billion", "outputValue": 2700 },
    "acceptedUnits": [
      { "unit": "USD billion", "multiplier": 1000 },
      { "unit": "USD", "multiplier": 0.000001 }
    ]
  }
}
```

`targetField`、`definition`、`unit`、`scale` 必填。`example` 和 `acceptedUnits` 可选。转换规则为 `canonicalValue = value * multiplier`，仅支持正的乘法转换；百分点、百分比变化、指数水平之间不能当作单位转换。没有可靠结算定义的题目会在调用模型前停止，待补充并复核。

每次模型输出必须包含 JSON 数字 `value`、准确的 `target_field` 和实际使用的 `unit`。harness 先检查字段和单位，再换算数值与标准差，最后聚合；原响应与转换记录均保留。没有声明的单位、缺失字段、错误字段、数值位置上的文字或空字符串都拒绝进入聚合。声明一致并不能证明研究选对了指标，仍需核对定义与证据。

正式候选写入前再次检查最终值和 trial 元数据。开放题的数值 fallback、无有效 trial 的结果不能生成正式候选，失败记录保留在 checkpoint，修复后可使用 `--resume --retry-fallbacks`。默认策略对截止时已经结束且禁止检索的题目，仍允许明确标记的确定性 fallback。正式输出仍需 100% 覆盖与 strict validator，通过后只生成本地候选。

新 checkpoint 和 manifest 带有 `numericContractVersion: 1`，并继续绑定 routes 文件哈希。旧 checkpoint 不能直接用于新正式运行；旧题目及结果仍可通过默认离线 adapter 阅读、评分。新合同不能通过给旧预测补标签来伪装成通过验证的新预测。

回归测试覆盖不同单位同量聚合、换算幂等性、标准差同比换算、负数与零、百分数与比例、错误字段/单位、畸形输出、旧结果回用及失败候选拦截。没有使用本轮已发生结果优化预测参数，也没有调用付费模型。
