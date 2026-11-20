export const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const families = ['sol', 'terra', 'astra', 'luna'];
const tasks = ['combined', 'pompeii', 'pelican', 'candy'];
const requireValue = (condition, message) => { if (!condition) throw new TypeError(message); };
const count = value => Number.isSafeInteger(value) && value >= 0;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function normalizeSelection(value = {}) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'Invalid selection policy.');
  const selection = { excludedEfforts: ['ultra'], excludeUnused: true, aboveMean: true, minIntelligenceGainPercent: 5, minSpeedPercent: 66, preferMajorityEffort: true, ...value };
  requireValue(Object.keys(value).every(k => Object.hasOwn(selectionDefaults, k)), 'Unknown selection policy field.');
  requireValue(Array.isArray(selection.excludedEfforts) && new Set(selection.excludedEfforts).size === selection.excludedEfforts.length && selection.excludedEfforts.every(e => efforts.includes(e)), 'Invalid excluded efforts.');
  requireValue(typeof selection.excludeUnused === 'boolean' && typeof selection.aboveMean === 'boolean' && typeof selection.preferMajorityEffort === 'boolean', 'Invalid selection filters.');
  requireValue(Number.isFinite(selection.minIntelligenceGainPercent) && selection.minIntelligenceGainPercent >= 0 && Number.isFinite(selection.minSpeedPercent) && selection.minSpeedPercent >= 0 && selection.minSpeedPercent <= 100, 'Invalid selection thresholds.');
  return selection;
}
const selectionDefaults = { excludedEfforts: true, excludeUnused: true, aboveMean: true, minIntelligenceGainPercent: true, minSpeedPercent: true, preferMajorityEffort: true };

export function selectEfforts(usage, iq, policy = {}) {
  const selection = normalizeSelection(policy);
  const included = efforts.filter(e => !selection.excludedEfforts.includes(e));
  requireValue(usage?.contract === 'deng-practical/1' && usage.ok === true && usage.complete === true && usage.source === 'codex' && usage.demo === false, 'Expected a complete, non-demo Codex practical snapshot.');
  requireValue(date(usage.from) && date(usage.to) && date(usage.asOf) && Date.parse(usage.from) < Date.parse(usage.to), 'Invalid usage snapshot timestamps.');
  requireValue(iq?.schema === 'codex-four-task-results/1' && iq.protocol === 'codex-four-weighted-150-v2' && iq.score_max === 150, 'Unsupported intelligence scoring contract.');
  requireValue(date(iq.score_snapshot_at) && typeof iq.round_id === 'string', 'Missing intelligence snapshot identity.');
  requireValue(tasks.every(k => iq.task_weights?.[k] === ({ combined: 60, pompeii: 45, pelican: 22.5, candy: 22.5 })[k]), 'Intelligence task weights changed.');
  requireValue(Array.isArray(usage.models) && Array.isArray(iq.rows), 'Missing model or intelligence rows.');
  const versions = new Map();
  for (const row of usage.models) {
    const family = /^gpt-\d+(?:\.\d+)*-(sol|terra|astra|luna)$/.exec(row.model)?.[1];
    if (!family) continue;
    requireValue(!versions.has(row.model) && count(row.requests) && Array.isArray(row.efforts), 'Invalid or duplicate usage model: ' + row.model);
    const requests = new Map();
    for (const level of row.efforts) {
      requireValue([...efforts, 'unknown'].includes(level.effort) && !requests.has(level.effort) && count(level.requests), 'Invalid or duplicate effort count: ' + row.model);
      requests.set(level.effort, level.requests);
    }
    requireValue([...requests.values()].reduce((s, n) => s + n, 0) === row.requests, 'Effort counts do not match model requests: ' + row.model);
    const heat = included.reduce((s, level) => s + (requests.get(level) ?? 0), 0);
    if (heat > 0) versions.set(row.model, { model: row.model, family, heat, requests, totalRequests: row.requests });
  }
  const selections = {};
  for (const family of families) {
    const ranked = [...versions.values()].filter(v => v.family === family).sort((a, b) => b.heat - a.heat || a.model.localeCompare(b.model));
    requireValue(ranked.length > 0, 'No used model for family: ' + family);
    requireValue(ranked.length === 1 || ranked[0].heat !== ranked[1].heat, 'Version heat is tied; no version tie-break rule: ' + family);
    const chosen = ranked[0], supported = iq.model_efforts?.[chosen.model];
    requireValue(Array.isArray(supported) && new Set(supported).size === supported.length && supported.every(e => efforts.includes(e)), 'Missing or unsupported intelligence efforts: ' + chosen.model);
    const majorityEffort = selection.preferMajorityEffort && included.find(e => e !== 'ultra' && (chosen.requests.get(e) ?? 0) > chosen.totalRequests / 2);
    if (majorityEffort) requireValue(supported.includes(majorityEffort), 'Majority effort is not supported by the selected model: ' + chosen.model + '/' + majorityEffort);
    const expected = included.filter(e => supported.includes(e));
    requireValue(expected.length > 0, 'No scored included efforts: ' + chosen.model);
    const source = iq.rows.filter(r => r.model === chosen.model && !selection.excludedEfforts.includes(r.effort));
    requireValue(source.length === expected.length && expected.every(e => source.filter(r => r.effort === e).length === 1), 'Incomplete or duplicate intelligence rows: ' + chosen.model);
    const levels = expected.map(effort => {
      const row = source.find(r => r.effort === effort);
      let score = 0, seconds = 0;
      for (const task of tasks) {
        const value = row[task];
        requireValue(value && Number.isFinite(value.model_elapsed_seconds) && value.model_elapsed_seconds > 0, 'Invalid task duration: ' + chosen.model + '/' + effort + '/' + task);
        if (task === 'candy') requireValue(typeof value.correct === 'boolean', 'Missing candy result: ' + chosen.model + '/' + effort);
        const part = task === 'candy' ? (value.correct ? 100 : 0) : task === 'pompeii' ? value.score100 : value.score;
        requireValue(Number.isFinite(part) && part >= 0 && part <= 100, 'Invalid task score: ' + chosen.model + '/' + effort + '/' + task);
        score += part * iq.task_weights[task] / 100;
        seconds += value.model_elapsed_seconds;
      }
      return { effort, requests: chosen.requests.get(effort) ?? 0, score, seconds };
    });
    const meanScore = levels.reduce((s, r) => s + r.score, 0) / levels.length;
    const candidates = levels.filter(r => (!selection.excludeUnused || r.requests > 0) && (!selection.aboveMean || r.score > meanScore));
    if (!majorityEffort) requireValue(candidates.length > 0, selection.excludeUnused && selection.aboveMean ? 'No used effort strictly above the model mean: ' + chosen.model : 'No effort meets the selection filters: ' + chosen.model);
    let selected = majorityEffort ? levels.find(r => r.effort === majorityEffort) : candidates[0];
    const comparisons = [];
    for (const higher of majorityEffort ? [] : candidates.slice(1)) {
      const lower = selected;
      const popular = higher.requests > lower.requests;
      // Cross-products preserve strict intelligence and inclusive speed boundaries.
      const intelligencePass = higher.score * 100 > lower.score * (100 + selection.minIntelligenceGainPercent);
      const speedPass = lower.seconds * 100 >= higher.seconds * selection.minSpeedPercent;
      const upgrade = popular && intelligencePass && speedPass;
      comparisons.push({ lower: lower.effort, higher: higher.effort, lowerRequests: lower.requests, higherRequests: higher.requests,
        intelligenceGain: higher.score / lower.score - 1, speedRatio: lower.seconds / higher.seconds,
        decision: upgrade ? 'higher' : 'lower', reason: !popular ? 'higher_not_more_used' : !intelligencePass ? `intelligence_gain_not_over_${selection.minIntelligenceGainPercent}_percent` : !speedPass ? `speed_below_${selection.minSpeedPercent}_percent` : 'all_upgrade_conditions_met' });
      if (upgrade) selected = higher;
    }
    selections[family] = {
      selected: { model: chosen.model, ...selected }, meanScore,
      decision: majorityEffort ? 'version_majority' : 'score_speed_comparison',
      majority: majorityEffort ? { effort: majorityEffort, requests: chosen.requests.get(majorityEffort), totalRequests: chosen.totalRequests, share: chosen.requests.get(majorityEffort) / chosen.totalRequests } : null,
      versions: ranked.map(v => ({ model: v.model, requests: v.heat })),
      levels: levels.map(r => ({ ...r, eligible: r === selected && !!majorityEffort || candidates.includes(r), excluded: r === selected && majorityEffort ? null : selection.excludeUnused && r.requests === 0 ? 'unused' : selection.aboveMean && r.score <= meanScore ? 'not_above_mean' : null })),
      comparisons,
    };
  }
  const defaultExclusions = selection.excludedEfforts.length === 1 && selection.excludedEfforts[0] === 'ultra';
  return { schema: 'codextopkits-effort-selection/1', usageBasis: defaultExclusions ? 'known_non_ultra_request_count' : 'included_effort_request_count', intelligenceMean: defaultExclusions ? 'all_supported_non_ultra_efforts' : 'all_supported_included_efforts',
    sources: { usage: { from: usage.from, to: usage.to, asOf: usage.asOf }, intelligence: { roundId: iq.round_id, scoreSnapshotAt: iq.score_snapshot_at } }, selections };
}
