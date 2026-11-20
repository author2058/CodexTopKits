export function findRoleModelAnchor(root) {
  const selector = '[data-codex-intelligence-trigger="true"],[data-composer-navigation-target="reasoning"]';
  const model = root.querySelector(selector);
  if (model) {
    const wrapper = model.parentElement;
    const anchor = wrapper?.tagName === 'SPAN' && wrapper.children.length === 1 ? wrapper : model;
    return { model, parent: anchor.parentElement, before: anchor, strategy: 'model' };
  }
  const ring = root.querySelector('[role="img"] svg circle[pathLength="100"]');
  const icon = ring?.closest('[role="img"]');
  if (!icon) return null;
  const wrapper = icon.parentElement;
  const anchor = wrapper?.tagName === 'SPAN' && wrapper.children.length === 1 ? wrapper : icon;
  let next = anchor.nextElementSibling;
  while (next?.getAttribute('data-cdtk-owned') === 'role-model-selection') next = next.nextElementSibling;
  const candidate = next?.querySelector('button') || (next?.tagName === 'BUTTON' ? next : null);
  return { model: candidate, parent: anchor.parentElement, before: next, strategy: 'context' };
}

export function readRoleModelControl(trigger) {
  const key = trigger && Object.getOwnPropertyNames(trigger).find(name => name.startsWith('__reactFiber$'));
  let selection, models, owner;
  for (let fiber = key ? trigger[key] : null; fiber; fiber = fiber.return) {
    const props = fiber.memoizedProps || {};
    selection ||= props.selectedLabelCandidate;
    if (typeof props.onSelectModel === 'function' && Array.isArray(props.models)) models ||= props.models;
    if (!Object.hasOwn(props, 'conversationId') || !Object.hasOwn(props, 'hasThreadResumeFailed')) continue;
    const candidates = new Set();
    for (const cache of fiber.updateQueue?.memoCache?.data || []) for (const value of cache) {
      const candidate = value?.modelSelection || value;
      if (candidate?.modelSettings && typeof candidate.selectComposerModelAndReasoningEffort === 'function') candidates.add(candidate);
    }
    if (candidates.size !== 1) throw new Error('Native composer model settings owner changed.');
    owner = { api: [...candidates][0], threadId: props.conversationId, hostId: props.permissionsHostId };
    break;
  }
  if (!owner || !selection?.model || !models) throw new Error('Native composer model selection interface is unavailable.');
  return { ...owner, selection, models };
}

export async function applyRoleModelControl(control, desired) {
  const model = control.models.find(row => row.model === desired.model);
  if (!model || model.disabledReason || !model.supportedReasoningEfforts?.some(row => row.reasoningEffort === desired.effort)) throw new Error('The recommended model and effort are unavailable in this composer: ' + desired.model + '/' + desired.effort);
  const accepted = await control.api.selectComposerModelAndReasoningEffort(desired.model, desired.effort, () => {}, { persistAsDefault: false });
  if (accepted !== true) throw new Error('Codex did not accept the recommended composer settings.');
}
