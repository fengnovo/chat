import { execFileSync } from 'node:child_process';

const ports = [...new Set(['PORT', 'API_PORT'].map((name) => {
  const value = process.env[name];
  if (!value) throw new Error(`[dev] ${name} must be set in .env`);

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`[dev] ${name} must be a valid TCP port`);
  }
  return port;
}))];

function listeningPids(port) {
  try {
    return execFileSync('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\s+/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

for (const port of ports) {
  for (const pid of listeningPids(port)) {
    try {
      process.kill(Number(pid), 'SIGTERM');
      console.log(`[dev] released port ${port} (PID ${pid})`);
    } catch {
      // The process may have exited between lsof and SIGTERM.
    }
  }
}

console.log(`[dev] ports ready: ${ports.join(', ')}`);
