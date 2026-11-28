import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../../..');
const rows = (path: string) => readFileSync(path, 'utf8').split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split('|'));

/** 항목 추가·중복·시험 파일 삭제를 놓치지 않게 실제 인수 목록과 연결표를 대조한다. */
export function writeCoverage(out: string) {
  const cases = rows(join(repo, 'docs/ui/acceptance-cases.tsv'));
  const mapped = rows(join(import.meta.dirname, 'uat-map.tsv'));
  assert.equal(new Set(mapped.map(row => row[0])).size, mapped.length, 'UAT 연결 중복');
  assert.deepEqual(mapped.map(row => row[0]).sort(), cases.map(row => row[0]).sort(), '인수 항목과 UAT 연결표가 다릅니다.');
  const scenarios = rows(join(import.meta.dirname, 'scenarios.tsv'));
  assert.deepEqual(scenarios.map(row => row[0]).sort(), [...Array.from({ length: 36 }, (_, i) => String(i + 1)), '11-1', '11-2'].sort(), 'G§12 시나리오 누락');
  for (const row of [...mapped, ...scenarios]) for (const path of row.slice(1, 3)) {
    if (path !== '-') assert(path && existsSync(join(repo, path)), `연결한 시험 파일이 없습니다: ${path ?? ''}`);
  }
  const link = (path: string | undefined) => path && path !== '-' ? `[${path.replace('agent-wbs/', '')}](${join(repo, path)})` : '—';
  const representative = (row: string[]) => {
    const title = row[4];
    assert(title, `${row[0] ?? ''} 대표 시험 이름 누락`);
    const path = row.slice(1, 3).find(path => path && path !== '-' && readFileSync(join(repo, path), 'utf8').includes(title));
    assert(path, `${row[0] ?? ''} 대표 시험이 소스에 없습니다: ${title}`);
    const source = readFileSync(join(repo, path), 'utf8');
    const line = source.slice(0, source.indexOf(title)).split('\n').length;
    return `[${title.replaceAll('[', '\\[').replaceAll(']', '\\]')}](${join(repo, path)}:${line})`;
  };
  const lines = [
    '# UAT 항목별 시험 연결', '',
    '한 행은 원본 UAT 한 항목이다. 대표 시험 이름은 해당 시험이나 연속 시나리오의 단계를 가리킨다.',
    '각 파일의 나머지 하위 판정 시험과 서버 보충 시험도 함께 실행한다.',
    '이 표는 시험 연결표다. 합격 증거는 commands.json의 종료 코드와 playwright.json의 개별 결과다.',
    '판정 범위에 적은 미구현 항목은 명령이 통과해도 미구현이다. 별도 작업의 구현과 검증이 필요하다.',
    '화면의 가짜 응답 시험과 실제 서버 보충 시험은 서로 다른 증거다.', '',
    '| UAT ID | 필수 마일스톤 | 대표 시험·단계(소스 위치) | 화면 시험 | 서버·Runner 보충 | 판정 범위 |', '|---|---|---|---|---|---|',
    ...mapped.map(row => `| ${row[0] ?? ''} | ${cases.find(c => c[0] === row[0])?.at(-1) ?? ''} | ${representative(row)} | ${link(row[1])} | ${link(row[2])} | ${row[3] ?? ''} |`),
    '', '# G§12 시나리오 연결', '', '| 번호 | 화면 시험 | 서버·Runner 보충 | 적용 결정 |', '|---|---|---|---|',
    ...scenarios.map(row => `| ${row[0] ?? ''} | ${link(row[1])} | ${link(row[2])} | ${row[3] ?? ''} |`),
  ];
  writeFileSync(join(out, 'UAT.md'), `${lines.join('\n')}\n`);
  return [...new Set([...mapped, ...scenarios].map(row => row[2] ?? '-').filter(path => path !== '-'))].sort();
}
