export class WindowRegistry {
  constructor(processId) {
    if (!Number.isSafeInteger(processId) || processId <= 0) throw new TypeError('Invalid Codex browser process ID.');
    this.processId = processId; this.windows = new Map(); this.nextOrder = 0;
  }
  add(targetId) {
    if (!this.windows.has(targetId)) this.windows.set(targetId, { targetId, order: this.nextOrder++, handle: null });
    return this.windows.get(targetId);
  }
  remove(targetId) { this.windows.delete(targetId); }
  bind(targetId, placement) {
    const row = this.windows.get(targetId);
    if (!row || placement?.processId !== this.processId || !Number.isSafeInteger(placement.handle) || placement.handle <= 0) throw new Error('窗口不属于当前 Codex 实例。');
    for (const other of this.windows.values()) if (other.handle === placement.handle) other.handle = null;
    row.handle = placement.handle;
  }
  update(targetId, value) { Object.assign(this.add(targetId), value); }
  rows() { return [...this.windows.values()].filter(value => value.applicable).sort((a, b) => a.order - b.order); }
}

export function middleEllipsis(value, maxWidth, measure) {
  if (measure(value) <= maxWidth) return value;
  const characters = Array.from(value);
  let left = Math.ceil(characters.length / 2), right = characters.length - left, trimLeft = true;
  const candidate = () => characters.slice(0, left).join('') + '...' + (right ? characters.slice(-right).join('') : '');
  while (left + right && measure(candidate()) > maxWidth) {
    if (trimLeft && left || !right) left--; else right--;
    trimLeft = !trimLeft;
  }
  return candidate();
}
