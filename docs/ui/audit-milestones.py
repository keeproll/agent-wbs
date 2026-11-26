#!/usr/bin/env python3
"""계획 기준선과 UAT 전체의 화면/API/Runner 가용 시점을 대조한다."""
import argparse
import json
import re
import subprocess
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
BASE = 'a60216d'


def screen_owner(sid):
    if sid == 'UI-00': return 'M0-04'
    if sid == 'UI-AUTH' or sid.startswith('SYS-'): return 'M3-01'
    if sid.startswith('MOD-'):
        return {'01':'M3-01', '02':'M6-04', '03':'M6-03', '04':'M6-03',
                '05':'M3-04', '06':'M3-02', '07':'M3-05', '08':'M3-01'}[sid[4:6]]
    if sid.startswith('UI-03'):
        return 'M3-03' if sid.startswith(('UI-03-', 'UI-03E', 'UI-03F')) else 'M3-02'
    if sid.startswith('UI-12-04'): return 'M6-03'
    if sid.startswith('UI-12-05'): return 'M6-04'
    return {'01':'M3-07', '02':'M3-04', '04':'M6-07', '05':'M3-05', '06':'M3-06',
            '07':'M3-07', '08':'M7-05', '09':'M3-05', '10':'M3-07',
            '11':'M6-01', '12':'M3-08'}[sid[3:5]]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    opt = parser.parse_args()
    plan = subprocess.check_output(['git', 'show', BASE+':docs/plan/milestones.md'], text=True)
    tasks = {}
    for n, line in enumerate(plan.splitlines(), 1):
        if re.match(r'^\| M\d-\d{2} \|', line):
            cells = line.split('|')
            tasks[cells[1].strip()] = (n, cells[2].strip(), cells[5])
    edges = {ms:set() for ms in tasks}
    stage_graph = plan.split('```mermaid')[1].split('```')[0]
    for line in stage_graph.splitlines():
        stages = re.findall(r'M[0-8]\b', line)
        for before, after in zip(stages, stages[1:]):
            for target in tasks:
                if target.startswith(after+'-'):
                    edges[target].update(t for t in tasks if t.startswith(before+'-'))
    for target, (_, _, parallel) in tasks.items():
        edges[target].update(re.findall(r'M\d-\d{2}', parallel))
    # M3 화면은 공통 상태/셸을 먼저 사용한다. ∥는 번호순 완료를 뜻하지 않는다.
    for target in tasks:
        if target.startswith('M3-') and target != 'M3-01': edges[target].add('M3-01')

    apis = {
        'AUTH':'M2-01', 'SHELL':'M2-01', 'RESP':'M2-01,M2-02,M2-07',
        'STATE':'M2-01', 'PROJECT':'M2-03', 'RESET':'M2-03,M2-04',
        'WBS':'M2-02,M2-07', 'WIZ':'M2-02', 'TASK':'M2-02,M2-06,M2-08',
        'PLAN':'M2-07', 'CP':'M2-07', 'EXEC':'M2-05,M2-06,M2-08',
        'GATE':'M2-06,M7-04', 'MSG':'M2-05,M2-06,M2-08', 'VERIFY':'M2-06',
        'HISTORY':'M2-08', 'DASH':'M2-02,M2-06,M2-07,M2-08',
        'RUNNER':'M2-05,M2-08', 'GITHUB':'M2-03,M2-08', 'POLICY':'M2-07,M2-08',
        'DESIGN':'M6-05', 'CI':'M2-05,M2-06,M7-04', 'REPORT':'M6-01',
        'MAIL':'M6-01,M6-03', 'TG':'M6-04', 'APPROVE':'M2-02,M2-08',
    }
    extra_api = {
        'SHELL-02':'M2-03', 'SHELL-03':'M2-05', 'RESP-01':'M7-04',
        'RESP-02':'M6-04,M7-04', 'STATE-01':'M2-02,M2-08',
        'STATE-02':'M2-02,M6-01', 'STATE-02-UI':'M2-02',
        'STATE-03':'M2-07,M2-08', 'STATE-06':'M2-02', 'STATE-08':'M2-02',
        'PROJECT-02':'M2-08', 'PROJECT-06':'M2-02', 'PROJECT-09':'M2-07',
        'PROJECT-10':'M2-07', 'PROJECT-11':'M2-02,M2-07,M2-08',
        'TASK-04':'M2-07', 'TASK-06':'M2-07', 'TASK-10-CI':'M7-04',
        'EXEC-02':'M7-04', 'EXEC-06':'M7-04', 'GITHUB-02':'M6-03,M6-04',
        'REPORT-04':'M6-02', 'REPORT-05':'M6-02', 'REPORT-06':'M6-02',
        'MAIL-03':'M6-02', 'MAIL-04':'M6-02,M6-04', 'TG-05':'M7-04',
        'TG-09':'M6-03,M7-04',
    }
    empty_apis = ['M2-02,M2-06,M2-08','M2-07','M2-05,M2-06,M2-08',
                  'M2-06,M2-08','M7-04','M6-01','M6-03','M6-04','M6-05',
                  'M2-02','M2-05,M2-08']
    # 링크가 표시되기만 하는 항목과 달리 실제 이동/열람하는 목적 화면도 포함한다.
    targets = {
        'STATE-08':'UI-03-01', 'PROJECT-06':'UI-03E', 'PROJECT-09':'UI-03B',
        'PROJECT-11':'UI-03B,UI-05,UI-09', 'WBS-04':'UI-03E', 'TASK-06':'UI-09A',
        'TASK-10':'UI-06', 'TASK-11':'UI-03E', 'PLAN-01':'UI-09A',
        'VERIFY-01':'UI-03E,UI-06', 'VERIFY-03':'UI-03E', 'HISTORY-01':'UI-03E',
        'DASH-01':'UI-03B,UI-03E,UI-05,UI-09,UI-06,UI-12-01B',
        'GITHUB-01':'UI-02E', 'POLICY-01':'UI-03E', 'POLICY-03':'UI-03E',
        'DESIGN-04':'UI-04-02', 'CI-06':'UI-03E', 'REPORT-03':'UI-03E',
        'MAIL-03':'UI-12-04A', 'TG-09':'UI-03E,UI-09A,UI-08-01A,UI-02,UI-04',
    }
    runtime = {
        'SHELL-03':'M4-01', 'PROJECT-01':'M4-01,M4-03,M4-04',
        'PROJECT-03':'M4-01,M4-03,M5-01,M5-04',
        'PROJECT-04':'M4-01,M4-03,M5-01,M5-04',
        'PROJECT-05':'M4-01,M4-03,M5-01,M5-04',
        'PROJECT-08':'M4-01,M4-03,M4-04', 'RESET-03':'M4-01,M4-03,M4-04',
        'RESET-04':'M4-01', 'PLAN-01':'M4-01,M5-01,M5-04',
        'EXEC-01':'M5-05', 'EXEC-02':'M5-05,M7-01', 'EXEC-03':'M4-01,M4-02',
        'EXEC-04':'M5-05', 'EXEC-05':'M5-05', 'EXEC-06':'M5-05,M7-02,M7-06',
        'EXEC-07':'M5-05', 'EXEC-08':'M5-02', 'EXEC-09-RUNNER':'M5-02,M5-03,M5-05',
        'GATE-01':'M7-02,M7-06', 'GATE-02':'M7-02,M7-06',
        'MSG-02':'M5-05', 'MSG-03':'M5-05', 'RUNNER-01':'M4-01,M4-02',
        'RUNNER-02':'M4-05,M5-03,M8-04', 'RUNNER-03':'M4-01,M4-02',
        'RUNNER-04':'M4-01,M4-02', 'RUNNER-05':'M5-02,M5-03',
        'GITHUB-01':'M4-01,M4-04', 'POLICY-02':'M5-02,M5-06',
        'DESIGN-01':'M6-06', 'DESIGN-04':'M6-06', 'CI-01':'M4-01',
        'CI-02':'M5-05,M7-02,M7-06', 'CI-03':'M5-05,M7-02',
        'CI-04':'M7-01', 'CI-05':'M7-03', 'CI-06':'M7-03', 'TG-05':'M7-06',
    }
    rows = []
    for line in (HERE/'acceptance-cases.tsv').read_text().splitlines():
        if not line or line.startswith('#'): continue
        cells = line.split('|')
        aid, screens, method, given, action, expected, source, mm, assigned = cells
        key = aid[4:]
        family = key.split('-')[0]
        ui = screens.split(',') + list(filter(None, targets.get(key,'').split(',')))
        ui = sorted(set(ui))
        api = set((empty_apis[int(key[-2:])-1] if family=='EMPTY' else apis[family]).split(','))
        api.update(filter(None, extra_api.get(key,'').split(',')))
        runner = set(filter(None, runtime.get(key,'').split(',')))
        required = {screen_owner(s) for s in ui} | api | runner
        assert required <= tasks.keys() and assigned in tasks, (aid, required)
        assert all(m[1] <= assigned[1] for m in required), (aid, assigned, required)
        edges[assigned].update(required-{assigned})
        rows.append(dict(id=aid, milestone=assigned, screens=ui, api=sorted(api), runner=sorted(runner)))
    # Kahn: 계획 선행과 각 UAT의 실제 대상 가용 선행을 합친 그래프에서 검출한다.
    pending = {k:set(v) for k,v in edges.items()}
    order = []
    while pending:
        ready = sorted(k for k,v in pending.items() if not v)
        assert ready, f'마일스톤 순환: {pending}'
        order.extend(ready)
        for k in ready: del pending[k]
        for deps in pending.values(): deps.difference_update(ready)
    assert len({r['id'] for r in rows}) == len(rows)
    counts = dict(sorted(Counter(r['milestone'] for r in rows).items()))
    report = (HERE/'milestone-audit.md').read_text().split('<!-- AUDIT-GENERATED -->')[0].rstrip()
    out = ['## 전 UAT 화면·API·Runner 대조', '',
           f'계획 {BASE}, **{len(rows)}개 전수 대조**, 지정 시점보다 뒤 단계의 필수 기능0건, 선행 그래프 **순환0건**.', '',
           '표 읽는 법:', '',
           '- 각 UI 셀은 화면ID=구현 마일스톤이다.',
           '- API/Runner 셀은 해당 계획 작업 전체를 먼저 완료해야 한다.',
           '- 빈 Runner 셀(—)은 브라우저/API 또는 fake 보고 fixture의 판정이며 실제 CLI 성공을 뜻하지 않는다.', '',
           '| UAT | 필수 통과 | 실제 표시/이동 대상 UI=구현 작업 | 필요한 API 작업 | 실제 Runner 작업 |',
           '|---|---|---|---|---|']
    for r in rows:
        out.append('| '+r['id']+' | '+r['milestone']+' | '+', '.join(s+'='+screen_owner(s) for s in r['screens'])+' | '+', '.join(r['api'])+' | '+(', '.join(r['runner']) or '—')+' |')
    out += ['', '## 마일스톤별 수', '', '| 마일스톤 | UAT 수 |', '|---|---:|']
    out += [f'| {m} | {n} |' for m,n in counts.items()]
    out += ['', '## 대조한 계획 작업과 줄', '', '| 작업 | 계획 줄 | 범위 |', '|---|---:|---|']
    out += [f'| {m} | {n} | {scope} |' for m,(n,scope,_) in tasks.items()]
    out += ['', '## 검증 선행의 실행 가능한 한 순서', '', ' → '.join(order), '']
    result = report+'\n\n<!-- AUDIT-GENERATED -->\n\n'+'\n'.join(out)
    path = HERE/'milestone-audit.md'
    if opt.check: assert path.read_text()==result, 'milestone-audit.md 재생성 필요'
    else: path.write_text(result)
    print(json.dumps(dict(baseline=BASE, cases=len(rows), cycleCount=0,
                         laterStageDependencyCount=0, milestones=counts), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
