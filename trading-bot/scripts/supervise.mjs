// Keeps the bot running: restarts it if the process exits or crashes, with backoff.
// Usage: node scripts/supervise.mjs [extra args passed to the bot]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const useDist = existsSync(new URL('../dist/index.js', import.meta.url));
const cmd = useDist ? process.execPath : 'npx';
const base = useDist ? ['dist/index.js', 'run'] : ['tsx', 'src/index.ts', 'run'];
let delay = 2000;
let stopping = false;

function launch() {
  const started = Date.now();
  const child = spawn(cmd, [...base, ...args], { stdio: 'inherit', shell: !useDist });
  console.log(`[supervise] started bot pid ${child.pid}`);
  child.on('exit', (code, signal) => {
    if (stopping) return;
    const ranMs = Date.now() - started;
    if (ranMs > 60_000) delay = 2000; // healthy run resets the backoff
    console.log(`[supervise] bot exited (code ${code}, signal ${signal}); restarting in ${delay / 1000}s`);
    setTimeout(launch, delay);
    delay = Math.min(delay * 2, 60_000);
  });
  const stop = () => {
    stopping = true;
    child.kill('SIGINT');
    setTimeout(() => process.exit(0), 3000);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
launch();
