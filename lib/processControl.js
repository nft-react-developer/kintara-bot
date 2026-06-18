const fs = require('fs');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function isProcessRunning(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function stopPid(pid, { signal = 'SIGTERM', forceAfterMs = 8000, log = null } = {}) {
  if (!pid) return false;
  try {
    process.kill(pid, signal);
    if (forceAfterMs > 0) {
      const timer = setTimeout(() => {
        if (!isProcessRunning(pid)) return;
        try {
          process.kill(pid, 'SIGKILL');
          log?.(`force killed pid ${pid}`);
        } catch {}
      }, forceAfterMs);
      timer.unref?.();
    }
    return true;
  } catch {
    return false;
  }
}

function stopPidFile(pidfile, options = {}) {
  const pid = readJson(pidfile)?.pid;
  const stopped = stopPid(pid, options);
  try { fs.unlinkSync(pidfile); } catch {}
  return stopped ? pid : null;
}

module.exports = { readJson, isProcessRunning, stopPid, stopPidFile };
