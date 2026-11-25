// installFakeCli가 만든 실행 파일의 본체. argv: <scenario> <calls> <CLI 인자...>
import { appendFileSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Call, Scenario } from './cli.ts';

const [scenarioPath = '', callsPath = '', ...argv] = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8')) as Scenario;

if (scenario.ignoreSigterm) process.on('SIGTERM', () => undefined);

let stdin = '';
if (!process.stdin.isTTY) {
  for await (const chunk of process.stdin.setEncoding('utf8')) stdin += String(chunk);
}
const call: Call = { argv, cwd: process.cwd(), envNames: Object.keys(process.env).sort(), stdin };
appendFileSync(callsPath, `${JSON.stringify(call)}\n`);

for (const [index, line] of (scenario.lines ?? []).entries()) {
  if (index > 0 && scenario.delayMs) await sleep(scenario.delayMs);
  process.stdout.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
}
if (scenario.stderr) process.stderr.write(scenario.stderr);
if (scenario.hang) setInterval(() => undefined, 60_000);
process.exitCode = scenario.exitCode ?? 0;
