# Raven-FutureX 改造版 · 得分最大化开发计划

> **状态:计划,未开发。** 本文是 Raven 引擎面向 FutureX 的专用改造(下称 **raven-futurex**)的开发计划。
> 执行前需用户确认预算与时间线。英文版见 [`2026-08-17-raven-futurex-score-max-plan.en.md`](2026-08-17-raven-futurex-score-max-plan.en.md)。

最后更新:2026-08-17

## 执行结果（2026-08-18 更新）

**计划已执行完毕，但架构结论在读代码后被推翻。** 原计划"新建 `packages/raven-futurex` + 移植 300 行 harness"约 70% 是重复造轮子：仓库已有完整管线（router、任务转换、提交构建与校验、scorer、带断点续跑的 worker pool、四道 CLI 门禁）。改为**沿现有接缝扩展**三个包，未新建包（新建会破坏 `check-boundaries.mjs` 的依赖白名单）。

已交付（提交 `ebfeb05` → `0541fce`，均在 main）：

| 项 | 状态 | 关键事实 |
| --- | --- | --- |
| Claude CLI provider | ✅ | 从"可选"提升为 P0：机器上无 `PREDICTOR_API_KEY`，CLI 持有的订阅是唯一可用模型access。带 AbortSignal→SIGTERM |
| 输出契约 | ✅ | 提示从未要求过 `<answer>` 块而解析器一直在找；实测导致整题产出 0 行 |
| 容错解析 `parse.ts` | ✅ | 平衡括号扫描替代无保护 `JSON.parse`，按题型抢救 |
| 推理留存 | ✅ | `thinking`/`role` 进 trial，`<output>.reasoning.jsonl` 成为一等产物 |
| ranking 误路由 | ✅ | 1 道题曾使整个 run 崩溃，现为 0 |
| 数值契约路由 | ✅ | 9 道题重新路由，占总分 **0.1442** |
| 数值尺度 | ✅ | `parseNumber` 拆为 probability/quantity；`2.7%` 不再变 `0.027`（原本精确得 0） |
| 期望得分决策 | ✅ | numeric 网格搜索、multi_label 期望 F1、free_response 折叠聚类 |
| never-abstain | ✅ | `fallbackFor` + batch worker try/catch |
| 按 level 配算力 | ✅ | `metadata.level` 此前无人读取 |
| `route-review` 命令 | ✅ | 80/80 已 approved，**drift = 0** |
| open-window 门禁 | ✅ | 由全局否决改为分区 |
| 对抗审查修复 | ✅ | 4 个确认缺陷，含 set-decision 空集 regret 0.82 |

**端到端实证**：三条 solver 路径均跑通，含开场判定"不可执行"的 Keysight 数值题（1744.87）与曾使 run 崩溃的 Esports 题（Team Falcons）。168 测试通过。

**未做**：全量 80 题 live run 与正式提交（需用户确认，见 §7）。原 §3 的 P0/P5 与新包方案作废。

## 0. 背景与目标

- 现状:2026-08-19 轮 80 题,通用二元 Raven 只能接 12 题(见 [`pilots/futurex/2026-08-19-3tier/`](../pilots/futurex/2026-08-19-3tier/)),**总分理论上限约 0.13**——因为缺答记 0 分,且已跑的 12 题几乎全是权重最低的 L1。
- 目标:构建 raven-futurex 层,**每题必答、按计分规则出最优答案、按 level 权重配算力**,单轮总分目标 **0.5–0.65**。
- 不改变的底线:as-of 证据冻结(答题不得使用题目 end_time 后的信息)、来源可追溯、manifest 如实记录每题的方法与降级情况。

## 1. 事实依据:计分规则 → 最优决策规则

计分规则全部出自本仓库 [`packages/benchmarks/src/futurex/scorer.ts`](../packages/benchmarks/src/futurex/scorer.ts),逐条倒推:

| # | 计分规则(行号) | 最优决策规则 |
|---|---|---|
| R1 | 缺答 = 0,无惩罚(L57) | **每题必答**。弃权严格劣于瞎猜;fail-closed 改为"降级作答 + manifest 标注" |
| R2 | 总分 = 0.1·L1 + 0.2·L2 + 0.3·L3 + 0.4·L4 各级均分加权(L105) | 单题边际价值 L4 ≈ 3.6×L1(0.4/22 vs 0.1/20)。**算力按 level 倒序分配**;L3+L4 共 43 题占总分 70% |
| R3 | single_choice 精确匹配、无部分分(L61) | 只有 argmax 有价值;概率校准不加分,资源花在排序正确性上 |
| R4 | numeric:max(0, 1−((x−t)/σ)²),σ=5%·\|t\|(L36-40) | 对预测分布做**期望得分网格搜索**,不取均值/中位数;财报题一致预期通常偏差 1–3%,±5% 窗口宽松 |
| R5 | multi_choice 按 set-F1(L64) | 每候选纳入概率 → 枚举子集取期望 F1 最大(候选集小,穷举可行) |
| R6 | ranking:全对 1,否则 0.8×命中率;重复实体 = 0(L69-77) | 先保集合命中,再按边际胜率排序;输出前查重 |
| R7 | open_text:本地精确匹配,线上语义判官(L88-90) | 候选生成 → 二元引擎逐个验证 → 输出官方规范写法 |
| R8 | 题型判定 = `task_type ?? routeFutureXQuestion`(L42-44) | **分类权威 = 本仓库 router / routes.json**,predict-raven 的正则分类器降级为交叉校验(两者当前在 ~15 题上有分歧) |

## 2. 架构决策

- **代码位置:本仓库新包 `packages/raven-futurex`。** 理由:scorer、router、submission 协议、route review 门禁都在这里;predict-raven 保持为通用二元引擎,benchmark 专用的得分最大化逻辑不反向污染它。
- **引擎调用:移植 predict-raven 的最小 Claude CLI harness**(`claude --print --output-format stream-json` + 来源追踪 + fail-closed 校验,约 300 行,来源 `predict-raven@codex/futurex-raven-adapter`),不建 workspace 依赖,保持两仓库解耦。移植文件头部标注出处。
- **三档保留**(Urd=haiku-4.5/low、Verdandi=sonnet-5/medium、Skuld=opus-5/high),但从"全量三档对比"改为"**按 level 分配 + 分歧升档**"(见 §4)。
- **routes.json 为唯一分类源**;发现 router 疑似误路由时走人工 review 修正 route,不在代码里绕过。

## 3. 工作分解

### P0 · 骨架与门禁(0.5 天)

- routes.json 加载器(校验 revision 匹配、拒绝 pending route 进入正式 run——review 流程见 P5)
- "每题必答"runner 骨架:题目 → 按 route.kind 分发到对应 solver → 失败时降级链(低档重试 → 保底启发式答案),每题记录 `method` 与降级原因
- 官方 JSONL 输出 + 本仓库 `futurex validate` 通过
- 按 level 的预算分配器与并发调度(题目级并行,worker 数可配)
- **验收:合成题集端到端跑通,80/80 有答案,validate 通过,manifest 完整**

### P1 · numeric solver(20 题,大量 L3/L4;1 天)

- 研究阶段产出**预测分布**:财报类 = 分析师一致预期 + 公司指引 + 历史 beat/miss 散布,输出蒙特卡洛样本;宏观/计数类 = 基率 + 近期趋势
- 决策阶段:`score(x) = mean_j max(0, 1−((x−t_j)/(0.05·|t_j|))²)` 在网格上取 argmax;分布紧时自动退化为均值,双峰时避开均值陷阱
- 输出精度对齐题面要求(如 `revenue_usd_millions` 不带单位、逗号)
- **验收:单元测试覆盖紧分布/宽分布/双峰/truth≈0(zeroSigma)四类;对历史已结算题回测期望得分 ≥ 均值策略**

### P2 · single_choice solver(37 题,含 12 道二元;1 天)

- 一次共享研究 → 输出各选项概率单纯形(harness 校验和为 1),提交 argmax
- L3/L4 且 top-2 概率差 < 0.15 时,追加一对 one-vs-rest 精跑作 tiebreak
- 12 道二元题复用现有二元路径,仅答案序列化对齐 route key(`Yes`/`No` vs `A`/`B`)
- **验收:对 8/19 轮 12 道二元题重放,答案与三档 pilot 的高档结论一致;概率单纯形校验拒绝不归一输出**

### P3 · open_text solver(22 题;1 天)

- 候选生成(独立检索,禁读市场类信号照旧)→ 每候选用二元引擎问"官方答案将是 X" → argmax
- 规范化:输出官方拼写/命名(scorer 仅做小写+空白折叠);候选与最终答案都存入 manifest 供语义判官争议时复核
- **验收:候选集为空时降级为"最高频检索实体"并标注;不允许输出解释性长句**

### P4 · multi_choice + ranking(约 4 题;0.5 天)

- multi_choice:每候选纳入概率 → 穷举子集取期望 F1 最大
- ranking:边际胜率排序(候选多时上 Plackett-Luce),输出前查重(重复实体 = 0 分)
- **验收:期望 F1 枚举有单测(含空集/全集边界);ranking 输出无重复**

### P5 · 提交管线与 route review(0.5 天 + 人工)

- route review 工具:把 80 条 route 生成一页式审核清单(题面 + router 判定 + 我方分类器交叉校验 + 分歧高亮),人工批量 approve 后写回 `reviewedAtUtc`——**这是协议门禁,需要用户参与,预计人工 30–60 分钟**
- 正式 run 接入本仓库 `futurex run` 协议语义:pending route 阻断、deadline 校验、submission manifest
- 结算后回填:题目 resolve 后跑本地 scorer,按 level 出分,沉淀到 `pilots/`(或晋升为正式记录)
- **验收:dry-run 全流程演练一遍(不花模型钱);live run 输出通过 validate + 人工抽查 3 题**

## 4. 算力预算与调度

单题成本按 8/17 pilot 实测折算(账面 API 等价价,实走 Max 订阅):Urd ≈ $0.70/题、Verdandi ≈ $3.2/题、Skuld ≈ $4.5/题;open_text/多选项题按候选数放大 2–3×。

| Level | 题数 | 首跑档位 | 升档规则 | 预算(账面) |
|---|---|---|---|---|
| L1 | 20 | Urd | 不升 | ~$15 |
| L2 | 17 | Verdandi | 不升 | ~$55 |
| L3 | 21 | Verdandi | top-2 接近或与 Urd 交叉分歧 → Skuld | ~$70–100 |
| L4 | 22 | Skuld | 直接高档 | ~$100–150 |

**单轮合计(账面)约 $240–320,墙钟约 3–5 小时(题目级并行 4 worker)。** 分歧升档的依据:8/17 pilot 里唯一的档间分歧(Duplantis 题,92.3pp 极差)正是低档方向性翻车——分歧本身就是最可靠的升档信号。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| open_text 线上语义判官与本地精确匹配不一致 | 输出官方规范写法;manifest 存候选集与理由,争议可复核 |
| numeric 无一致预期可查(冷门指标) | 降级为基率分布并放宽网格;manifest 标 `method: base-rate` |
| router 误路由(与我方分类器 15 题分歧) | P5 review 清单高亮分歧题,人工裁决,修 route 不绕过 |
| 高档 0.99 饱和(pilot 已观察到 5 题) | argmax 不受影响(R3);numeric/多选路径概率上限夹到 0.98 再进决策 |
| 8/19 轮时间窗(最早题 8/19 20:00 GMT+8 截止) | 见 §6;若开发延误,优先保 P0+P1+P2(覆盖 57 题、总分 ~85% 的可得分池),P3/P4 降级为保底答案 |
| Claude CLI 凭证失效(8/17 踩坑:keychain ACL) | preflight 先跑一次 1-token 调用验活,失败即 abort 并提示修复命令 |

## 6. 时间线(假设 8/18 上午开工)

- **8/18 上午**:P0;**8/18 下午**:P1 + P2(可并行)
- **8/18 晚**:P5 dry-run + route review(需用户 30–60 分钟)
- **8/19 上午**:P3 + P4;**8/19 午后**:live run(全部在最早 end_time 20:00 前完成并锁定)
- 8/20+:结算回填与复盘

## 7. 需要用户拍板的事项

1. **预算确认**:单轮账面 $240–320(Max 订阅额度)是否可接受
2. **route review 参与**:80 条 route 的人工 approve(约 30–60 分钟,P5 工具会尽量压缩)
3. **提交口径**:live run 产物是否作为本轮正式 submission candidate 走邮件提交流程(FutureX 无提交 API,runbook 要求人工邮件 + 指定正文字段)
