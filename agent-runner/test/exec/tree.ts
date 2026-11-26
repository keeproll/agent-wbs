import { spawn } from 'node:child_process';
// 부모만 먼저 끝나도 자손을 종료해야 한다. 자손은 TERM도 무시한다.
const unmarked = process.argv.includes('--unmarked-group');
const child = spawn(unmarked ? '/usr/bin/python3' : process.execPath, unmarked
  ? ['-c', 'import os,signal,time; os.setpgid(0,0); signal.signal(signal.SIGTERM,signal.SIG_IGN); print("ready",flush=True); time.sleep(60)']
  : ['-e', 'process.on("SIGTERM",()=>{}); process.stdout.write("ready"); setInterval(()=>{},1000)'], { detached: process.argv.includes('--detach'), env: { ...process.env, ...(unmarked && { AWBS_LAUNCH_ID: '' }) }, stdio: ['ignore', 'pipe', 'ignore'] });
child.stdout.once('data', () => { process.stdout.write(`${String(child.pid)}\n`); process.exit(0); });
