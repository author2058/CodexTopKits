# Role Model Selection

[English](README.md) | 简体中文

Role Model Selection 是可选 Kit，可将角色推荐的模型和思考档位应用到 Codex 聊天。每个聊天默认处于 **未指定**，保留现有设置；选择角色后，Kit 才应用建议。该功能支持主聊天，以及带输入框的子聊天或旁聊天。

## 启用与使用

安装 `codex-toolkit-session` 和 Core 0.3.41 或更高版本。在 Kit 运行时将 `services.role-models.module` 设置为 `codex-toolkit-session/role-model-service`，然后在 **Kits** 中启用 `role-model-selection`，选择 **Restart Kit host**。该 Kit 默认关闭。

角色控件显示在原生模型控件左侧；原生模型控件仅显示图标时也是如此。如果该位置不可用，请查看上下文用量圆环右侧。选择角色后，Kit 将推荐的模型和思考档位应用到当前聊天；进行中的回合结束后再应用新设置。Kit 保留聊天的服务档位和全局默认设置。

选择 **未指定** 可恢复使用原生模型选择器。手动选择模型也会清除当前聊天的角色。

## 角色与推荐

六个可编辑的默认角色依次为 Responder（Sol）、Implementer（Terra）、Operator（Luna）、General reviewer（Sol）、Advanced reviewer（Astra）和 Researcher（Astra）。选择角色菜单末尾的 **角色设置…**，编辑角色名称、模型家族和选择参数后选择 **保存**。在同一面板选择 **刷新推荐** 可手动刷新。角色名称是可编辑文本。

功能的设置服务启动时检查一次推荐数据，之后可选择 **刷新推荐** 再次检查。检查新数据期间，设置页可显示上次保存的推荐；加载或计算出错时会显示错误。

推荐基于公开请求分布和四题智力结果。Kit 与独立命令共用计算逻辑；默认规则和数据来源见[模型档位选择](../../../../docs/model-effort-selection.zh-CN.md)。

默认情况下，Kit 选出家族中使用最多的版本后，如果某个未排除的非 ultra 档位占该版本总请求数超过一半，Kit 会直接选用该档位。总请求数包含 unknown 和 ultra 请求。可在 **角色设置…** 中关闭多数档优先，改由其他得分与速度规则决定档位。

## 依赖版本的原生集成

角色控件和设置应用依赖 Codex 原生聊天控件及设置接口。如果 Codex 版本更改这些接口，或者账号无法使用推荐的模型与档位，Kit 会报告问题；原生模型控件仍可使用。

[开始使用](../../../../docs/getting-started.zh-CN.md) · [全部 Kits](../../../../README.zh-CN.md#kits)
