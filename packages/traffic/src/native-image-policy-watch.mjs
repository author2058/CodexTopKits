export function createNativePolicyWatcher({ check, log, changed }) {
  const controller = new AbortController(), versions = new Set();
  let work = Promise.resolve(), error = null, report = null, running = false, stopped = false, metadataError = null;
  const snapshot = () => ({ error: error ?? metadataError, report, running });
  const publish = () => changed(snapshot());
  const request = force => {
    const task = work.then(async () => {
      controller.signal.throwIfAborted();
      running = true; publish();
      try {
        report = await check({ force, signal: controller.signal });
        error = report.ok ? null : new Error(report.failures.join('\n'));
        await log({ event: 'native-image-policy-checked', ok: report.ok, cached: report.cached, version: report.version,
          policyId: report.policyId, failures: report.failures });
        return report;
      } catch (failure) {
        if (controller.signal.aborted && (failure === controller.signal.reason || failure.name === 'AbortError')) throw failure;
        error = failure;
        try { await log({ event: 'native-image-policy-failed', name: failure.name, message: failure.message, stack: failure.stack }); }
        catch (logError) { throw new AggregateError([failure, logError], 'Native policy check and logging failed.', { cause: failure }); }
        throw failure;
      } finally { running = false; publish(); }
    });
    // Serialize later explicit checks after an already reported failure.
    work = task.catch(() => {});
    return task;
  };
  return {
    snapshot,
    idle: () => work,
    swap(apply) {
      const task = work.then(async () => {
        versions.clear(); error = null; report = null; running = true; publish();
        try { await apply(); } catch (failure) { error = failure; throw failure; }
        finally { running = false; publish(); }
      });
      work = task.catch(() => {}); return task;
    },
    check: () => request(true),
    observe(version) {
      if (stopped) return;
      if (typeof version !== 'string' || !version) {
        if (!metadataError) {
          metadataError = new Error('Native version metadata is missing; automatic image-policy checks are unavailable.');
          publish();
        }
        return;
      }
      metadataError = null;
      if (versions.has(version)) { publish(); return; }
      versions.add(version);
      void request(false).catch(failure => {
        if (!controller.signal.aborted) console.error('Native image-policy check failed:', failure);
      });
    },
    async close() {
      stopped = true;
      controller.abort(new DOMException('Native policy watcher stopped.', 'AbortError'));
      await work;
    },
  };
}
