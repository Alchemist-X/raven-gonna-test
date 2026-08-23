# DSH 式 forecasting engine 改造方案

日期：2026-08-22　　状态：**plan only，未实施**　　英文版：[`2026-08-22-dsh-style-harness-plan.en.md`](2026-08-22-dsh-style-harness-plan.en.md)

## 一、DSH 研究结论

**DeepSeek Harness（dsh）**：deepseek-ai 2026-08-13 开源的 agent 框架，v0.1 developer preview。Node ≥22.19 / pnpm monorepo（与本仓库同栈）。核心：vendored **Cordis** 插件内核（只做挂载/卸载/依赖追踪，"no privileged core"），**一切皆插件**——模型、工具、技能、会话、沙箱、存储、**agent loop 本身**都是可换插件；append-only session log 支持 resume/fork/replay；四种运行模式（Standard/Code/Minimal/Creator）。"自进化"的实义 = 插件可在运行时安全热插拔（依赖追踪 + undo 栈 + 事务回滚），agent 因此可以改写自己的运行时。

**信源可信度（研究中的意外发现）**：

| 渠道 | 判定 |
| --- | --- |
| `github.com/deepseek-ai/deepseek-harness` + repo 内 docs | **唯一权威契约** |
| npm `@deepseek-ai/dsh`（scoped） | 官方分发渠道 |
| npm `deepseek-harness`（unscoped，0.0.1，个人账号） | **抢注占位，禁止安装** |
| deepseekharness.io | 自声明"unofficial, not affiliated"；内容尚可但非契约 |
| deepseek-code.com / deepseekdocs.com 等 | SEO 仿站群，不作依据 |

**成熟度警报**：发布至今 10 天，11 个版本全是 rc（0.1.1-rc.2 为最新），官方明言 "THERE WILL BE COMPATIBILITY-BREAKING CHANGES"；无 `--json` 输出 flag；session 存储位置"docs 不承诺"；2,117 个社区插件无签名无权限清单，`dsh plugin add` 等于裸执行任意包。

## 二、总判断：采纳"组合语法"，拒绝"运行时机器"

dsh 的独特机器（Cordis、fiber、effect 逆操作、事务性 HMR、"时空可组合性"形式化）全部服务于一个前提：**长驻进程内安全热替换代码**。我们的引擎是**短命批处理进程**——"热替换"就是改配置重启，OS 进程边界天然就是完美的 undo 栈（连 Cordis 论文自己都承认 inverse 正确性"是对组件作者的义务而非运行时验证的性质"）。对基准引擎，**运行中换 harness 是复现性 bug 不是 feature**。

但 dsh 有三个**值得偷的思想**，恰好逐一命中我们已知的痛点：

1. **Capability Seam（接口 / provider / 消费者三分）** → 我们加一个 provider 要改 enum + createPort 分支 + 散落 env；
2. **声明式配置装配整个 harness** → 我们的旋钮散在 PREDICTOR_* env 和各命令代码里；
3. **"model-visible means logged" + 可 dump 的完整装配** → 我们的 harness 身份一半在 manifest 一半靠脑补，正是矩阵可比性一直缺的"指纹"。

## 三、七个 Seam 映射（现状 → 接口 → 默认 provider id）

| Seam | 现状 | 接口 | 默认 id |
| --- | --- | --- | --- |
| model | `ModelPort`（已是 seam！三个 predictor 类不动） | 原样 + provider 包装 | `openai-compatible` / `claude-cli` / `codex-cli` |
| model 中间件 | `ConcurrencyLimitedModel` 手工包 | 装配期 decorator | `concurrency-limit` |
| prompt | `prompt.ts` buildPrompts + engine 内联 persona 后缀 | `PromptStrategy.build(task, policy, trial)` | `prompt-v1` |
| parser | `parseModelAnswer` + salvage 路径 | `AnswerParser.parse(task, response)` | `lenient-salvage-v1` |
| trials（**dsh "loop 是插件" 的类比，仅装配期**） | `ForecastEngine.forecast` 写死的 fan-out（engine.ts:235-269） | `TrialRunner` | `independent-personas-v1` |
| aggregator | `aggregateTrialPredictions` + numeric/set decision 硬连 | `Aggregator` + `DecisionModule` | `logit-pool-v1` 等 |
| benchmark | 三个 adapter（contract.ts 已是雏形） | `BenchmarkAdapter` 注册表 | `futurex` / `forecastbench` / `prophet-arena` |

**明确不做成 seam**（手写保留）：zod 契约、全部数学、**InformationPolicy**（永远是逐 task 校验的数据，不是可换组件，不可从 profile 设置）、artifacts/batch/checkpoint、`requirePaidOptIn` / routes-review 门（保持代码 + CLI flag，profile 的 zod `.strict()` 保证无法表达这些）。

## 四、Profile 与 harness 身份

- 新包 `packages/harness`，纯/杂分离：`registry.ts` + `builtin.ts` 纯（boundary linter 可管），只有 `profile.ts` 碰 env/fs；
- `profiles/*.json`（JSON 不引 YAML；沿用 matrix 已验证的 `$NAME` 秘密引用约定，loader 拒绝字面 secret）；单层 `extends` + CLI `--set`，**拒绝 dsh 的四层 patch 叠加**；
- 过渡期：现有 PREDICTOR_* env 翻译成 env-compat 层且**覆盖 profile**，一切现有调用字节级不变；
- `doctor --dump-config`：打印完整装配 + 每 key 来源层（dsh `--dump-config` 的类比）；
- 每份 manifest 增加 harness 块：`{ profile, resolved($NAME 保留), compositionHash(用 canonicalize.ts 做 canonical JSON 的 sha256), providerVersions }`——矩阵对比表此后按 compositionHash 对齐行。

## 五、迁移路线（每步 `pnpm verify` 全绿；下一轮付费 round 前冻结 schema）

1. core seam 抽取，零行为变化：接口进 contracts.ts，engine 构造器可选注入、默认现代码；trial fan-out 纯代码搬移进默认 TrialRunner——core.test.ts **一字不改**必须通过；
2. `packages/harness`（registry+builtin+tests），**同一 commit** 扩展 check-boundaries.mjs（core 不得 import harness；harness 的 registry/builtin 不得碰 env/fs）；
3. runtime catalog：三 predictor + 并发中间件注册，predictor 类与测试不动；
4. profile loader（extends / `--set` / `$NAME` / env-compat 复用 config.ts 的校验）；
5. CLI 切换：composeEngine(profile) 替换 createPort/createEngine，加 `--profile/--set/--dump-config`；
6. manifest harness 块；
7. benchmarks catalog + decision 按 id 解析；matrix 槽位支持 `{name, profile, patch}`；
8. 清理：废弃裸 PREDICTOR_* 路径；之后才做第一个真收益演示（第二个 TrialRunner 或 Aggregator）。

**收益**：矩阵从 harness × model 二维升到 **strategy × aggregator × harness × model** 四维，而每行有 compositionHash 指纹。

## 六、独立 track：dsh-cli 第三 CLI harness（probe-first）

动机：让 DeepSeek 槽位获得真检索（现在是零检索裸 completions）。结论：**可行但有前提**，10 天大的 rc、无 `--json`、session 存储契约未文档化。

1. 精确 pin `@deepseek-ai/dsh@<rc>` 为 devDependency，spawn `node_modules/.bin/dsh`（**不用 npx**，不装任何社区插件）；
2. 先写 `scripts/probe-dsh.mjs` 留在仓库当回归探针：`--profile headless` 的 stdout 契约、scratch `DSH_HOME` 下 session JSONL 形状、web 搜索事件里是 URL 还是仅 query、`--patch` 能否卸载 web 工具（deny-web 强制）、token 用量形状；
3. probe 通过才写 `DshCliPredictor`（镜像 codex-cli：per-call scratch home、有界重试、research=false 先 fail-closed、session log 解析不到就**判失败**而非静默零引用）；
4. 计费与其他 CLI 不同：花 **DEEPSEEK_API_KEY**（API 计费，同 openai-compatible），但研究能力像 claude-cli——文档必须写明；
5. 矩阵加 `ds-v4-dsh` 槽位与裸 completions `dsflash` 并排跑对照，人工复核后才准入付费 round；保留 dsflash 作 deny-web 路由兜底；
6. 每次版本 bump = 重跑 probe（codex 0.144→0.149 的教训）。

## 七、风险表（浓缩）

| 风险 | 缓解 |
| --- | --- |
| 3 provider / 2 策略的基数配不上"插件平台"复杂度 | registry 封顶 7 seam、纯 const 对象、单 provider 的东西拒绝 seam 化 |
| 字符串 id 侵蚀类型安全 | zod 校验 id ∈ registry keys，付费调用前 fail-closed |
| 迁移期双配置源打架 | env-compat 覆盖 profile 的单一优先级 + doctor 逐 key 溯源；每命令硬切换 |
| 安全门漂进配置 | `.strict()` schema；allow-paid / routes / policy 永不进 profile |
| compositionHash 不 canonical 导致对比表碎裂 | 复用 canonicalize.ts；默认装配钉住 `independent-trials-logit-v1` 保历史可比 |
| trial loop 抽取动到 abort/timeout 语义 | 纯代码搬移 + core.test.ts 不改先行验证 |
| 借了 dsh 词汇引来借 dsh 机制的压力 | 本文档 + AGENTS.md 明记：**零 dsh/Cordis 代码或依赖进仓**，动态加载 out of scope |

## 八、明确不采纳清单

Cordis 运行时 / 热插拔与 HMR / 自进化（cordis_define、Creator 模式——与"人审 routes 门控付费"直接冲突）/ 社区插件面与 `dsh plugin add` / Web UI 与未鉴权本地 RPC / 事件 hook 总线 / 新建 session-event-log 子系统（manifest 扩展即可）/ 四层 patch 叠加 / YAML / dsh 的 web-search seam 设计（不可关、后端不明——我们的 InformationPolicy fail-closed 严格更优，**不动**）。
