# 按角色选择模型档位

[English](model-effort-selection.md)

`tools/select-model-effort.mjs` 根据 Codex Radar 的公开请求分布与四题智力数据，为 Sol、Terra、Astra、Luna 计算模型版本和思考档位建议。独立命令要求 Node.js 24，只使用内置模块。[Role Model Selection Kit](../packages/session-recovery/kits/role-model-selection/README.zh-CN.md) 共用同一计算逻辑，并可将建议应用到聊天。

## 使用

在仓库根目录运行：

```powershell
node tools/select-model-effort.mjs
```

命令并行读取以下 JSON，将 UTF-8 JSON 结果输出到 stdout：

- [闭合两小时 Codex 请求分布](https://speed-api.codexradar.com/api/agent-speed/public/practical?source=codex&window=2h)
- [四题智力结果](https://codexradar.com/data/codex-four-task-results.json)

指定本地快照重放，或使用其他 URL：

```powershell
node tools/select-model-effort.mjs --usage C:/data/usage.json --iq C:/data/iq.json
node tools/select-model-effort.mjs --help
```

JSON 按严格 UTF-8 解码，兼容一个开头的 UTF-8 BOM。HTTP 使用标准代理环境变量以及运行时默认／系统证书。两个输入共用的加载期限默认为 60000ms，需要其他等待预算时可指定 `--timeout-ms`。错误保留诊断输出到 stderr，进程以失败退出；不重试或自动替换成缓存。

## 默认计算规则

1. 保持角色对应的模型家族，按 low、medium、high、xhigh、max 的请求总数选最常用版本，排除无人使用的版本。ultra 和未知档位不计入热度。来源统计的是请求次数，不是去重人数。
2. 对选定版本，如果某个未排除的非 ultra 档位占该版本总请求数严格超过 50%，直接选用该档位。分母包含该版本的全部请求，包括 ultra 和 unknown；其他版本不参与计算。恰好 50% 不触发。选定版本必须支持该档位并具有对应智力结果。
3. 从四题原始结果重算站点的 150 分制加权得分与任务总耗时。基线是全部受支持非 ultra 档位的算术平均分，其中仍包含零请求档位的智力成绩。触发多数规则时，得分仍可用于显示。
4. 没有符合条件的多数档位时，候选档位必须至少有一次已识别请求，且智力得分严格高于上述均值。
5. 从最低合格档开始，依次比较更高合格档。只有更高档请求更多、智力领先严格超过 5%、解题速度不低于较低档的 66%，才升档。速度比为“低档耗时／高档耗时”。请求数相等时保留低档。

结果包含数据时间窗、IQ 轮次、版本热度、平均分、候选排除原因、逐次比较及多数或比较规则的决策标识。多数决策还显示档位请求数、版本总请求数和占比。决策使用未舍入数值。最高热度版本并列、评分不完整或没有合格候选时明确报错；不新增版本并列规则、超过一次请求的样本门槛，也不假定账号一定支持建议组合。

其他程序可导入 `selectEfforts(usage, intelligence)`。函数输出可复现，且不修改输入；CLI 另附输入位置。

## 角色策略

Kit 中的每个聊天默认处于 **未指定**。六个可编辑的默认角色依次为 Responder（Sol）、Implementer（Terra）、Operator（Luna）、General reviewer（Sol）、Advanced reviewer（Astra）和 Researcher（Astra）。选择角色会将对应家族的建议应用到当前聊天；手动选择模型会清除当前聊天的角色。Kit 保留聊天的服务档位和全局默认设置。

Kit 的 **角色设置…** 可编辑角色名称、家族、多数档优先、排除的思考档位、无人使用档位与高于均分筛选条件，以及智力提升和速度阈值。被排除的档位不计入版本热度、模型均分或多数候选，但仍计入多数分母。默认排除项和阈值与上述计算规则一致；包含 `ultra` 时，其顺序位于 `max` 之后，且不会触发多数档优先。独立命令继续使用默认规则。其他程序可在 `selectEfforts` 的第三个参数中设置 `preferMajorityEffort: false`，关闭多数档优先。

Kit 首次启用或 Kit 宿主重新打开时刷新数据，也支持手动刷新。消息之间复用已有建议，进行中的回合结束后再应用新建议。配置方法及依赖版本的原生集成说明见 [Kit 指南](../packages/session-recovery/kits/role-model-selection/README.zh-CN.md)。
