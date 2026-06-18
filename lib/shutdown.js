function installGracefulShutdown({ log = console.log, cleanup, timeoutMs = 5000 } = {}) {
  let shuttingDown = false;

  const run = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const timer = setTimeout(() => process.exit(0), timeoutMs);
    timer.unref?.();

    Promise.resolve()
      .then(() => cleanup?.(signal))
      .catch((e) => {
        try { log(`shutdown cleanup failed: ${(e && e.message) || e}`); } catch {}
      })
      .finally(() => process.exit(0));
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => run(signal));
  }

  return () => shuttingDown;
}

module.exports = { installGracefulShutdown };
