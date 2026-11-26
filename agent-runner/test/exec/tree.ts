import { spawn } from 'node:child_process';
// 부모만 먼저 끝나도 자손을 종료해야 한다. 자손은 TERM도 무시한다.
const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); process.stdout.write("ready"); setInterval(()=>{},1000)'], { detached: process.argv.includes('--detach'), stdio: ['ignore', 'pipe', 'ignore'] });
child.stdout.once('data', () => { process.stdout.write(`${String(child.pid)}\n`); process.exit(0); });
