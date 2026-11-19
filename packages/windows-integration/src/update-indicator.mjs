export function updateIndicatorCss() {
  return 'button[data-cdt-hosted-update="active"]{position:relative!important}button[data-cdt-hosted-update="active"]::after{content:"";position:absolute;right:1px;bottom:1px;width:6px;height:6px;border-radius:50%;background:#22c55e;pointer-events:none;z-index:2}';
}

export function installHostedUpdateControl(window, native, { registerRestart, onStatus, onError }) {
  const attribute = 'data-cdt-hosted-update';
  let stopped = false, registered = false, error = null;
  const marked = new Set(), componentMatches = new WeakMap();
  const status = () => ({ installed: !stopped && registered, native: typeof native.services.appUpdates.installUpdate === 'function', busy: !stopped && !registered && !error, error });
  const isInstallButton = button => {
    const key = Object.getOwnPropertyNames(button).find(k => k.startsWith('__reactFiber$'));
    for (let fiber = key && button[key]; fiber; fiber = fiber.return) {
      if (typeof fiber.type !== 'function') continue;
      if (!componentMatches.has(fiber.type)) componentMatches.set(fiber.type, /\bid:\s*[`'"]appHeader\.installUpdate[`'"]/.test(Function.prototype.toString.call(fiber.type)));
      if (componentMatches.get(fiber.type)) return true;
    }
    return false;
  };
  const refreshButtons = () => {
    const next = new Set(!stopped && registered ? [...window.document.querySelectorAll('button')].filter(b => !b.disabled && isInstallButton(b)) : []);
    for (const button of marked) if (!next.has(button)) { button.removeAttribute(attribute); marked.delete(button); }
    for (const button of next) {
      if (button.getAttribute(attribute) !== 'active') button.setAttribute(attribute, 'active');
      marked.add(button);
    }
  };
  const publish = () => { refreshButtons(); onStatus(status()); };
  publish();
  const ready = Promise.resolve().then(registerRestart).then(result => {
    if (result?.registered !== true || result?.hookInstalled !== true || result?.hookVerified !== true) {
      throw new Error('Native update restart protection was not confirmed.');
    }
    registered = true;
    if (!stopped) publish();
    return result;
  }).catch(failure => {
    error = failure.message;
    if (!stopped) { publish(); onError(failure); }
    throw failure;
  });
  return { status, refreshButtons, ready, cleanup() { stopped = true; refreshButtons(); } };
}
