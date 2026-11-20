# Role Model Selection

English | [简体中文](README.zh-CN.md)

Role Model Selection is an optional Kit that applies a role's recommended model and reasoning effort to a Codex chat. Each chat starts as **Unassigned** and keeps its existing settings until a role is selected. The Kit supports the main chat and child or side chats with an input box.

## Enable and use

Install `codex-toolkit-session` and Core 0.3.41 or later. Configure the Kit runtime's `services.role-models.module` as `codex-toolkit-session/role-model-service`, enable `role-model-selection` in **Kits**, and choose **Restart Kit host**. The Kit is opt-in.

The role control appears to the left of the native model control, including its icon-only layout. If that location is unavailable, look to the right of the context usage ring. Select a role to apply its recommended model and reasoning effort to the current chat. An active turn finishes before the new settings are applied. The Kit keeps the chat's service tier and the global default settings unchanged.

To return control to the native model selector, choose **Unassigned**. Selecting a model manually also clears the current chat's role.

## Roles and recommendations

The six editable default roles are Responder (Sol), Implementer (Terra), Operator (Luna), General reviewer (Sol), Advanced reviewer (Astra), and Researcher (Astra). Open **Role settings…** at the end of the role menu to edit role names, model families, and selection parameters, then choose **Save**. Choose **Refresh recommendations** in the same panel to refresh manually. Role names are user-editable text.

Recommendation inputs are checked when the feature's settings service starts. Use **Refresh recommendations** to check again. The settings page can show the last saved recommendation while fresh inputs are checked; a loading or calculation error remains visible.

Recommendations use public request distribution and four-task intelligence results. The Kit and the standalone command share the same calculation; see [model effort selection](../../../../docs/model-effort-selection.md) for its default rules and data sources.

By default, after choosing the most-used version of a family, the Kit directly selects a non-excluded, non-ultra effort when it accounts for more than half of that version's total requests. The total includes unknown and ultra requests. **Role settings…** can turn off this majority preference; the other scoring and speed rules then determine the effort.

## Version-dependent native integration

The role control and application of settings depend on Codex's native chat controls and settings interfaces. If a Codex version changes those interfaces, or the recommended model and effort are unavailable to the account, the Kit reports the problem and the native model control remains available.

[Get started](../../../../docs/getting-started.md) · [All Kits](../../../../README.md#kits)
