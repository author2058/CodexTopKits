// Serialized into the renderer. Both tracks share reset-anchored 24-hour intervals.
export function weeklyProgress(weekly, now = Date.now()) {
  if (!weekly || !Number.isFinite(weekly.resetAt) || !Number.isFinite(weekly.remainingPercent) || !Number.isFinite(now)) return null;
  const dayMs = 86400000;
  const remainingDays = Math.max(0, (weekly.resetAt - now) / dayMs);
  const quotaDays = weekly.remainingPercent / 100 * 7;
  const days = Math.max(Math.ceil(remainingDays), Math.ceil(quotaDays));
  if (days === 0) return null;
  const startAt = weekly.resetAt - days * dayMs;
  const usagePercent = Math.max(0, Math.min(100, (days - quotaDays) / days * 100));
  const timeCell = Math.min(days - 1, Math.max(0, Math.floor((now - startAt) / dayMs)));
  // 06:00 GMT+8 is 22:00 UTC; locate it inside the reset-anchored day.
  const morningOffset = ((22 * 3600000 - startAt) % dayMs + dayMs) % dayMs;
  return {
    days,
    startAt,
    timePercent: Math.max(0, Math.min(100, (days - remainingDays) / days * 100)),
    usagePercent,
    timeMorningPercent: (timeCell + morningOffset / dayMs) / days * 100,
  };
}
