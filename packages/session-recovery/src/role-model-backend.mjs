import { selectEfforts } from './model-effort-calculator.mjs';
import { loadInputs as loadDefaultInputs } from './model-effort-source.mjs';
import { defaultRolePolicy, validateRolePolicy, roleThreadKey } from './role-model-policy.mjs';

export async function openRoleModelBackend({ filename, onChange = () => {}, onError = () => {}, loadInputs = signal => loadDefaultInputs({ signal }) }) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  if (typeof filename !== 'string' || !filename || typeof onChange !== 'function' || typeof onError !== 'function' || typeof loadInputs !== 'function') throw new TypeError('Invalid role model backend options.');
  let state = { policy: defaultRolePolicy(), assignments: {}, recommendations: null };
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(filename));
    const saved = JSON.parse(text);
    if (!saved || !saved.assignments || typeof saved.assignments !== 'object' || Array.isArray(saved.assignments) || !Object.hasOwn(saved, 'recommendations')) throw new TypeError('Invalid saved role model state.');
    const policy = validateRolePolicy(saved.policy);
    for (const [key, roleId] of Object.entries(saved.assignments)) {
      let pair;
      try { pair = JSON.parse(key); } catch (error) { throw new TypeError('Invalid saved assignment key.', { cause: error }); }
      if (!Array.isArray(pair) || pair.length !== 2 || roleThreadKey(...pair) !== key || !policy.roles.some(role => role.id === roleId)) throw new TypeError('Invalid saved assignment.');
    }
    state = { policy, assignments: saved.assignments, recommendations: saved.recommendations };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let inputs, currentError, queue = Promise.resolve(), pendingRefresh, refreshController, refreshWriteError, closed = false, recommendationsValidated = false;
  const snapshot = () => ({ ...structuredClone(state), recommendationsValidated, ...(currentError ? { error: currentError } : {}) });
  const notify = () => onChange(snapshot());
  const run = operation => {
    if (closed) return Promise.reject(new Error('Role model backend is closed.'));
    const result = queue.then(operation);
    queue = result.then(() => {}, () => {});
    return result;
  };
  const persist = async next => {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const temporary = filename + '.' + randomUUID() + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', flag: 'wx' });
    try { await fs.rename(temporary, filename); }
    catch (error) {
      try { await fs.unlink(temporary); } catch (cleanupError) { error.cleanupError = cleanupError; }
      throw error;
    }
    state = next;
  };
  const report = error => { currentError = error; onError(error); notify(); };
  return {
    snapshot,
    savePolicy: policy => run(async () => {
      const validated = validateRolePolicy(policy);
      const assignments = Object.fromEntries(Object.entries(state.assignments).filter(([, roleId]) => validated.roles.some(role => role.id === roleId)));
      let recommendations = state.recommendations, calculationError;
      if (inputs) {
        try { recommendations = selectEfforts(inputs.usage, inputs.iq, validated.selection); }
        catch (error) { recommendations = null; calculationError = error; }
      } else if (JSON.stringify(validated.selection) !== JSON.stringify(state.policy.selection)) recommendations = null;
      await persist({ policy: validated, assignments, recommendations });
      if (inputs) { currentError = calculationError; recommendationsValidated = !calculationError; }
      else if (!recommendations) recommendationsValidated = false;
      if (calculationError) onError(calculationError);
      notify();
      return snapshot();
    }),
    assign: ({ hostId, threadId, roleId }) => run(async () => {
      const key = roleThreadKey(hostId, threadId);
      if (roleId != null && roleId !== '' && !state.policy.roles.some(role => role.id === roleId)) throw new TypeError('Unknown role ID.');
      const assignments = { ...state.assignments };
      if (roleId == null || roleId === '') delete assignments[key]; else assignments[key] = roleId;
      await persist({ ...state, assignments });
      notify();
      return snapshot();
    }),
    refresh: () => {
      if (closed) return Promise.reject(new Error('Role model backend is closed.'));
      if (pendingRefresh) return pendingRefresh;
      const controller = new AbortController();
      refreshController = controller;
      refreshWriteError = undefined;
      pendingRefresh = (async () => {
        try {
          const loaded = await loadInputs(controller.signal);
          if (controller.signal.aborted) throw controller.signal.reason;
          return await run(async () => {
            const recommendations = selectEfforts(loaded.usage, loaded.iq, state.policy.selection);
            try { await persist({ ...state, recommendations }); } catch (error) { refreshWriteError = error; throw error; }
            inputs = loaded;
            currentError = undefined;
            recommendationsValidated = true;
            notify();
            return snapshot();
          });
        } catch (error) {
          if (!controller.signal.aborted || (error !== controller.signal.reason && error?.cause !== controller.signal.reason)) report(error);
          throw error;
        }
      })().finally(() => { pendingRefresh = undefined; refreshController = undefined; });
      return pendingRefresh;
    },
    close: async () => {
      closed = true;
      refreshController?.abort(new DOMException('Role model backend closed.', 'AbortError'));
      try {
        if (pendingRefresh) {
          try { await pendingRefresh; } catch (error) { if (error === refreshWriteError) throw error; }
        }
      } finally { await queue; }
    },
  };
}
