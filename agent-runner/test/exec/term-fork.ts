import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

// 종료 신호를 받은 뒤 다른 세션으로 자식을 보내는 가짜 CLI다.
process.once('SIGTERM', () => {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); process.stdout.write("ready"); setInterval(()=>{},1000)'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout.once('data', () => {
    writeFileSync(process.argv[2] ?? '', String(child.pid));
    process.exit(0);
  });
});
process.stdout.write('ready');
setInterval(() => undefined, 1000);
