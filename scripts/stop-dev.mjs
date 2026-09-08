/**
 * Stop anything still listening on the dev ports.
 *
 * This exists because `tsx watch` and `next dev` both spawn children that
 * outlive Ctrl-C often enough to matter. The failure it prevents is a nasty
 * one: a stale API keeps port 5001, the next `npm run dev` cannot bind, and the
 * web app then proxies every request to the OLD process — whose log is in a
 * terminal nobody is watching. Everything looks up, sign-in codes appear
 * nowhere, and the obvious suspects (account locked? rate limited? env wrong?)
 * are all innocent.
 */
import { execFileSync } from 'node:child_process';

const PORTS = [3000, 3100, 5001];
const isWindows = process.platform === 'win32';

function pidsOn(port) {
  try {
    if (isWindows) {
      const out = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Get-NetTCPConnection -LocalPort ${port} -State Listen -EA SilentlyContinue ` +
            `| Select-Object -Unique -ExpandProperty OwningProcess`,
        ],
        { encoding: 'utf8' },
      );
      return out.split(/\s+/).filter(Boolean);
    }
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' });
    return out.split(/\s+/).filter(Boolean);
  } catch {
    return []; // nothing listening on this port
  }
}

let stopped = 0;
for (const port of PORTS) {
  for (const pid of pidsOn(port)) {
    try {
      // /T also takes the children — a tsx or next parent left behind keeps the
      // port through its worker, so killing only the parent achieves nothing.
      if (isWindows) execFileSync('taskkill', ['/PID', pid, '/F', '/T'], { stdio: 'ignore' });
      else process.kill(Number(pid), 'SIGKILL');
      console.log(`  stopped pid ${pid} on port ${port}`);
      stopped += 1;
    } catch {
      console.log(`  could not stop pid ${pid} on port ${port} — stop it by hand`);
    }
  }
}

console.log(
  stopped
    ? `\n${stopped} process(es) stopped. Run "npm run dev" to start clean.`
    : 'Dev ports 3000, 3100 and 5001 are already free.',
);
