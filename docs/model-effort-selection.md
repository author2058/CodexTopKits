# Role-based model effort selection

[简体中文](model-effort-selection.zh-CN.md)

`tools/select-model-effort.mjs` calculates model-version and reasoning-effort recommendations for Sol, Terra, Astra and Luna from Codex Radar's public request distribution and four-task intelligence results. The standalone command requires Node.js 24 and uses built-in modules. The [Role Model Selection Kit](../packages/session-recovery/kits/role-model-selection/README.md) shares the same calculation and can apply recommendations to a chat.

## Run

From the repository root:

```powershell
node tools/select-model-effort.mjs
```

The command reads these JSON sources concurrently and writes UTF-8 JSON to stdout:

- [Closed two-hour Codex request distribution](https://speed-api.codexradar.com/api/agent-speed/public/practical?source=codex&window=2h)
- [Four-task intelligence results](https://codexradar.com/data/codex-four-task-results.json)

Replay local snapshots or supply alternative URLs:

```powershell
node tools/select-model-effort.mjs --usage C:/data/usage.json --iq C:/data/iq.json
node tools/select-model-effort.mjs --help
```

The JSON reader uses strict UTF-8 and accepts one leading UTF-8 BOM. HTTP requests use the standard proxy environment variables and the runtime's default/system certificate authorities. The shared input-loading deadline defaults to 60000ms; set `--timeout-ms` explicitly when a different waiting budget is needed. Errors retain their diagnostics on stderr and exit unsuccessfully. There is no retry or cached-data substitution.

## Default calculation rules

1. Keep each model family fixed. Rank its versions by the sum of requests at `low`, `medium`, `high`, `xhigh` and `max`; discard unused versions. `ultra` and unknown efforts do not contribute. Counts measure requests rather than unique users.
2. For that version, if an allowed non-ultra effort accounts for strictly more than 50% of the version's total requests, select it directly. The denominator includes all requests for that version, including `ultra` and `unknown`; other versions do not contribute. Exactly 50% does not qualify. The selected version must support the effort and have its intelligence results.
3. Reconstruct the site's 150-point weighted score and total author-task duration from its four task results. Calculate the unweighted mean across all supported non-ultra efforts, including efforts with zero usage requests. This score remains available for display when the majority rule applies.
4. If no majority effort qualifies, an effort qualifies only when it has at least one identified request and its score is strictly above that mean.
5. Start with the lowest qualifying effort and compare higher qualifying efforts in order. Upgrade only when the higher effort has more requests, its score is strictly more than 5% higher, and its solve speed is at least 66% of the lower effort's speed. Solve-speed ratio is `lower duration / higher duration`. Equal effort counts retain the lower effort.

The output includes snapshot timestamps, IQ round identity, version counts, mean scores, exclusions, each comparison, and a decision identifying the majority or comparison rule. A majority decision also reports the effort's request count, the version's total and its share. Numerical decisions use unrounded inputs. A tied hottest version, incomplete scoring data or no qualifying effort is an explicit error. The command adds no version tie-break, minimum-sample threshold above one request or model-availability assumption.

For programmatic use, import `selectEfforts(usage, intelligence)` from the command module. It is deterministic and does not mutate its inputs. The CLI additionally reports its input locations.

## Role policy

The Kit starts each chat as **Unassigned**. Its six editable default roles are Responder (Sol), Implementer (Terra), Operator (Luna), General reviewer (Sol), Advanced reviewer (Astra), and Researcher (Astra). Selecting a role applies its family's recommendation to the current chat; manual model selection clears that chat's role. The Kit preserves the chat's service tier and the global defaults.

The Kit's **Role settings…** menu allows changes to role names, families, the majority preference, excluded efforts, the unused-effort and above-mean filters, and the intelligence-gain and speed thresholds. Excluded efforts are omitted from version heat, the model's mean score and majority candidates, but remain in the majority denominator. The default exclusions and thresholds match the calculation rules above; when `ultra` is included, it follows `max` in the effort order and cannot trigger the majority preference. The standalone command retains those defaults. Programs can set `preferMajorityEffort: false` in the third argument to `selectEfforts` to disable the majority preference.

The Kit refreshes inputs on first enable or when the Kit host reopens and also supports manual refresh. It reuses the recommendation between messages. A running turn finishes before a new recommendation is applied. See the [Kit guide](../packages/session-recovery/kits/role-model-selection/README.md) for setup and version-dependent native integration.
