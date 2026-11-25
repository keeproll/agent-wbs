#!/usr/bin/env python3
"""원본을 변경하지 않고 UI 대조 증거를 재생성한다. Python 표준 라이브러리만 사용."""
import argparse
import hashlib
import json
import re
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
SOURCE = ROOT / 'prototype/uiux/Main.dc.html'
MARK = '<!-- GENERATED: extract.py -->'
VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}


def catalog():
    out = []
    for line in (HERE / 'catalog.tsv').read_text().splitlines():
        if not line or line.startswith('#'):
            continue
        cells = line.split('|')
        assert len(cells) == 9, line
        sid, kind, title, span, logic, entry, states, fields, results = cells
        start, end = map(int, span.split('-'))
        out.append(dict(id=sid, kind=kind, title=title, start=start, end=end, logic=logic,
                        entry=entry, states=states, fields=fields, results=results.split('；')))
    assert len({x['id'] for x in out}) == len(out)
    return out


def acceptance_cases(records):
    out = []
    known = {r['id'] for r in records} | {'UI-AUTH'}
    for line in (HERE/'acceptance-cases.tsv').read_text().splitlines():
        if not line or line.startswith('#'):
            continue
        cells = line.split('|')
        assert len(cells) == 9, line
        aid, screens, method, given, action, expected, source, mismatches, milestones = cells
        assert re.fullmatch(r'M[0-8]-\d{2}', milestones), f'필수 통과 마일스톤은 하나: {aid} {milestones}'
        row = dict(id=aid, screens=screens.split(','), method=method, given=given,
                   action=action, expected=expected, source=source,
                   mismatches=[] if mismatches == '-' else mismatches.split(','), milestones=milestones)
        assert set(row['screens']) <= known, row
        assert all([given, action, expected, method, source]), row
        out.append(row)
    assert len({r['id'] for r in out}) == len(out), '인수 ID 중복'
    covered = {sid for r in out for sid in r['screens']}
    assert covered == known - {'UI-13', 'UI-12-06A'}, f'제품 화면 대조 누락: {known-covered}'
    assert {m for r in out for m in r['mismatches']} == {f'MM-{i:02}' for i in range(1,32)}
    return out


class Template(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.nodes = []
        self.conditions = []
        self.loops = []
        self.events = []
        self.styles = []
        self.icons = []

    def handle_starttag(self, tag, attrs):
        line = self.getpos()[0]
        a = dict(attrs)
        node = dict(tag=tag, line=line, attrs=a, text=[],
                    conditions=[x['attrs']['value'] for x in self.stack if x['tag'] == 'sc-if'],
                    loops=[dict(list=x['attrs'].get('list'), alias=x['attrs'].get('as')) for x in self.stack if x['tag'] == 'sc-for'])
        self.nodes.append(node)
        if tag == 'sc-if':
            self.conditions.append(dict(id=f'CD-{len(self.conditions)+1:04}', line=line,
                                        expression=a.get('value'), ancestors=node['conditions']))
        if tag == 'sc-for':
            self.loops.append(dict(id=f'LP-{len(self.loops)+1:04}', line=line,
                                   expression=a.get('list'), alias=a.get('as'), ancestors=node['conditions']))
        for key, value in attrs:
            if re.fullmatch(r'on[a-z]+', key):
                self.events.append(dict(id=f'EV-{len(self.events)+1:04}', line=line,
                                        event=key, handler=value, node=node))
        if 'style' in a:
            self.styles.append(dict(line=line, value=a['style']))
        if tag == 'svg':
            self.icons.append(dict(line=line, attrs=a))
        if tag not in VOID:
            self.stack.append(node)

    def handle_endtag(self, tag):
        for i in range(len(self.stack)-1, -1, -1):
            if self.stack[i]['tag'] == tag:
                self.stack[i]['end'] = self.getpos()[0]
                del self.stack[i:]
                return

    def handle_data(self, data):
        if data.strip():
            for node in self.stack:
                if node['tag'] in {'button', 'label', 'a', 'select', 'h1', 'h2', 'h3', 'h4', 'textarea'}:
                    node['text'].append(data.strip())


def cell(value):
    return str(value).replace('|', '&#124;').replace('\n', ' ↵ ').replace('`', '&#96;')


def ref(start, end=None):
    return f'[원본 {start}' + (f'–{end}' if end and end != start else '') + f'](../../prototype/uiux/Main.dc.html#L{start})'


def replace_generated(path, body, check):
    old = path.read_text() if path.exists() else ''
    prefix = old.split(MARK)[0].rstrip()
    new = prefix + '\n\n' + MARK + '\n\n' + body.rstrip() + '\n'
    if check:
        assert old == new, f'재생성 필요: {path.name}'
    else:
        path.write_text(new)


def main():
    args = argparse.ArgumentParser()
    args.add_argument('--check', action='store_true')
    opt = args.parse_args()
    source = SOURCE.read_text()
    template = source[:source.index('<script type="text/x-dc"')]
    records = catalog()
    cases = acceptance_cases(records)
    p = Template()
    p.feed(template)
    events_regex = re.findall(r'\bon[A-Z][A-Za-z]*\s*=\s*"[^"]*"', template)
    assert len(events_regex) == len(p.events), 'HTMLParser/별도 정규식 이벤트 수 불일치'
    assert len(re.findall(r'<sc-if\b', template)) == len(p.conditions)
    assert len(re.findall(r'<sc-for\b', template)) == len(p.loops)

    def owners(line):
        choices = [r for r in records if r['start'] <= line <= r['end']]
        if not choices:
            return []
        size = min(r['end']-r['start'] for r in choices)
        return [r['id'] for r in choices if r['end']-r['start'] == size]

    missing = []
    for row in p.events + p.conditions + p.loops:
        row['screens'] = owners(row['line'])
        if not row['screens']:
            missing.append(row['id'])
    assert not missing, f'인벤토리 미분류: {missing}'
    lines = source.splitlines()
    # 원문 전체를 읽고 선언/메서드의 시작을 색인. 줄 구간은 다음 선언 직전까지.
    markers = []
    for i, line in enumerate(lines, 1):
        if i < 2904:
            continue
        m = re.match(r'^(?:const|function|class)\s+([A-Za-z_$][\w$]*)|^  (?:(get) )?([A-Za-z_$][\w$]*)\([^;]*?\)\s*\{', line)
        if m:
            markers.append(dict(line=i, name=m.group(1) or m.group(3), declaration=line.strip()))
    for i, m in enumerate(markers):
        m['end'] = markers[i+1]['line']-1 if i+1 < len(markers) else 7118
    # 해당 이름의 바인딩 후보 모두 제시한다. 반복 별칭의 이름이 같다고 같은 동작으로 합치지 않는다.
    for ev in p.events:
        name = re.sub(r'^{{\s*|\s*}}$', '', ev['handler']).split('.')[-1]
        ev['bindingCandidates'] = [i for i, line in enumerate(lines, 1) if i >= 4458 and re.search(r'(?<![\w$])'+re.escape(name)+r'\s*[:=]', line)]
        ev['label'] = ' '.join(ev['node']['text']) or ev['node']['attrs'].get('aria-label') or ev['node']['attrs'].get('title') or ev['node']['attrs'].get('placeholder') or ev['node']['tag']
        if ev['line'] == 2313:
            ev['runtimeNote'] = '죽은 잔재: ag.run/ag.slotOpts 제공 안 됨. 제품 행 제거(MM-24, 독립 리뷰 B1).'

    fields = [dict(line=n['line'], tag=n['tag'], attrs=n['attrs'], screens=owners(n['line']), conditions=n['conditions']) for n in p.nodes if n['tag'] in {'input', 'textarea', 'select'}]
    buttons_no_events = [dict(line=n['line'], text=' '.join(n['text']), attrs=n['attrs'], screens=owners(n['line'])) for n in p.nodes if n['tag'] == 'button' and not any(re.fullmatch('on[a-z]+', a) for a in n['attrs'])]
    summary = dict(source='prototype/uiux/Main.dc.html', sha256=hashlib.sha256(source.encode()).hexdigest(),
                   sourceLines=len(lines), catalogEntries=len(records), kinds=dict(Counter(r['kind'] for r in records)),
                   events=len(p.events), clickActions=sum(x['event']=='onclick' for x in p.events),
                   uniqueHandlerExpressions=len({x['handler'] for x in p.events}), conditions=len(p.conditions), loops=len(p.loops),
                   fields=len(fields), unclassified=missing, missingCount=len(missing),
                   inventoryBehaviorDescriptions=sum(len(r['results']) for r in records),
                   acceptanceBehaviorItems=len(cases), acceptanceConditionItems=0,
                   acceptanceMethods=dict(Counter(c['method'] for c in cases)),
                   buttonsWithoutEvent=len(buttons_no_events), browserVerified=False,
                   independentBrowserReview='evidence/browser.md')
    summary['acceptanceTotal'] = summary['acceptanceBehaviorItems'] + summary['acceptanceConditionItems']
    summary['acceptanceMilestones'] = dict(sorted(Counter(c['milestones'] for c in cases).items()))
    summary['acceptanceStages'] = dict(sorted(Counter(c['milestones'].split('-')[0] for c in cases).items()))
    evidence = dict(summary=summary, catalog=records, events=p.events, conditions=p.conditions, loops=p.loops,
                    fields=fields, inlineStyles=p.styles, icons=p.icons, buttonsWithoutEvent=buttons_no_events, logicIndex=markers)
    json_body = json.dumps(evidence, ensure_ascii=False, indent=2) + '\n'
    out = HERE / 'evidence' / 'template-audit.json'
    if opt.check:
        assert out.read_text() == json_body, 'template-audit.json 재생성 필요'
    else:
        out.parent.mkdir(exist_ok=True)
        out.write_text(json_body)

    inv = ['## 집계와 대조', '', '| 구분 | 개수 |', '|---|---:|']
    for label, value in [('인벤토리 항목', len(records)), ('최상위 메뉴', 12), ('이벤트 속성 발생', len(p.events)), ('클릭 액션 발생', summary['clickActions']), ('고유 핸들러 표현식', summary['uniqueHandlerExpressions']), ('sc-if 조건 발생', len(p.conditions)), ('sc-for 반복 발생', len(p.loops)), ('입력 요소 발생', len(fields)), ('분류 누락', len(missing)), ('인수 항목', summary['acceptanceTotal'])]:
        inv.append(f'| {label} | {value} |')
    inv += ['', '종류별: ' + ', '.join(f'{k} {v}' for k,v in summary['kinds'].items()) + '.', '',
            '같은 반복 행의 실제 데이터 건수는 세지 않고 템플릿 발생 위치를 센다. `open/pick` 같은 반복 별칭은 화면·줄 번호·상위 조건·반복 문맥으로 구분한다. 분류 누락 0은 정적 추출의 문서 연결 결과이며, 브라우저 동작 검증 성공을 뜻하지 않는다.', '', '## 화면·탭·패널·모달 인벤토리', '']
    for r in records:
        inv += [f'### {r["id"]} — {r["title"]} ({r["kind"]})', '',
                f'- 출처: {ref(r["start"],r["end"])}; 로직 {r["logic"]}.',
                f'- 진입: {r["entry"]}.', f'- 상태: {r["states"]}.', f'- 필드·표시 데이터: {r["fields"]}.',
                '- 액션·결과·이동: ' + ' / '.join(r['results']) + '.', '']
        local = [x for x in p.events if r['id'] in x['screens']]
        if local:
            inv += ['| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |', '|---|---:|---|---|---|']
            for e in local:
                guards = e['node']['conditions']
                dis = e['node']['attrs'].get('disabled')
                if dis is not None:
                    guards = guards + ['disabled='+str(dis)]
                label = e['label'] + (' — ' + e['runtimeNote'] if 'runtimeNote' in e else '')
                inv.append(f'| {e["id"]} | {e["line"]} | {cell(e["event"]+" "+e["handler"])} | {cell(label)} | {cell(" ∧ ".join(guards))} |')
            inv.append('')
        local_fields = [f for f in fields if r['id'] in f['screens']]
        if local_fields:
            inv += ['| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |', '|---:|---|---|---|']
            for f in local_fields:
                a = f['attrs']
                hints = {k:v for k,v in a.items() if k in {'type','required','disabled','min','max','step','pattern','maxlength','placeholder','aria-label','rows'}}
                inv.append(f'| {f["line"]} | {f["tag"]} | {cell(a.get("value",a.get("checked","")))} | {cell(json.dumps(hints,ensure_ascii=False))} |')
            inv.append('')
    inv += ['## 모든 조건 분기 대조', '', 'true일 때 해당 `sc-if` 하위 콘텐츠가 표시되고 false일 때 빠진다. 상위 조건이 false이면 하위는 진입하지 않는다. 정확한 상위 조건과 반복 별칭은 JSON 증거에 보존했다.', '', '| 조건 ID | 화면 ID | 줄 | 원문 조건 |', '|---|---|---:|---|']
    inv += [f'| {x["id"]} | {", ".join(x["screens"])} | {x["line"]} | {cell(x["expression"])} |' for x in p.conditions]
    inv += ['', '## 모든 반복 바인딩 대조', '', '| 반복 ID | 화면 ID | 줄 | 목록 → 별칭 |', '|---|---|---:|---|']
    inv += [f'| {x["id"]} | {", ".join(x["screens"])} | {x["line"]} | {cell(str(x["expression"])+" → "+str(x["alias"]))} |' for x in p.loops]
    inv += ['', '## 로직 전체 읽기 색인', '', '선언 시작~다음 선언 직전 구간이다. 중첩 함수는 소유 메서드 안에 포함된다. 로직 구간 전체를 읽고 UI 변경 흐름과 데이터 출처를 정리했으며 이 색인은 재검토 위치를 제공한다.', '', '| 선언/메서드 | 줄 범위 |', '|---|---|']
    inv += [f'| {x["name"]} | {x["line"]}–{x["end"]} |' for x in markers]
    replace_generated(HERE/'inventory.md', '\n'.join(inv), opt.check)

    ac = ['## 집계', '', f'실제 판정 항목 **{len(cases)}개**. 이전933개(원본 설명404 + 기계 조건529)에서 교체했다. 조건529개는 인수 총계에서 제외하고 inventory의 CD 추적 색인에만 남긴다.', '',
          '검증 방법별: ' + ', '.join(f'{k} {v}개' for k,v in summary['acceptanceMethods'].items()) + '.', '',
          '## 필수 통과 마일스톤', '',
          '각 UAT는 아래 **하나의 마일스톤에서 전체 기대 결과를 통과**해야 한다. M3 화면/API 사례와 M4 이후 실행 결합 사례는 서로 다른 ID다. 앞 단계의 fixture 성공으로 뒤 단계 체크박스를 체크하지 않는다. 세부 기대 a/b/c 중 하나라도 실패하면 해당 UAT 전체는 미통과다.', '',
          '| 마일스톤 | UAT 수 | 필수 판정 ID |', '|---|---:|---|']
    for ms, count in summary['acceptanceMilestones'].items():
        ac.append(f'| {ms} | {count} | '+', '.join(c['id'] for c in cases if c['milestones']==ms)+' |')
    ac += ['', '단계 합계: ' + ', '.join(f'{ms} {n}개' for ms,n in summary['acceptanceStages'].items()) + '.', '',
           'M3 필수 목록은 위 M3-01~08 행의 ID 전체다. M3는 M2 API와 fake Runner 보고 fixture로 화면·저장·전이·보류를 확인하고 Gate 대기까지 검사한다. M4 이후에는 각 항목에 적힌 실제 adapter/프로세스/프로토콜을 사용한다. M7-06도 유료 CLI·실 GitHub 인수가 아니라 fake CLI·로컬 git·fake GitHub를 거치는 실제 ①/② 파이프라인 결합이다. 유료 CLI/실 GitHub/실 SMTP·BotAPI는 계획 M8 gate를 별도로 충족한다.', '',
           '빈 상태 문구·생성 조건과 오류별 판정 ID는 [acceptance-coverage.md](acceptance-coverage.md)를 따른다. 원본의 동일 빈 문구로 구분되지 않는 경우 G86의 기록 없음/조건 불일치 구분이 제품 기준이다.', '',
           '## 화면 ID → 판정 항목', '', '| 화면 ID | 판정 ID |', '|---|---|']
    for sid in [r['id'] for r in records] + ['UI-AUTH']:
        ids = [c['id'] for c in cases if sid in c['screens']]
        reason = '정상 제품화면 제외; 모르는 URL404는 UAT-SHELL-05' if sid=='UI-13' else '주입 도구 제외; 실제 상태는 UAT-STATE 및 acceptance-coverage 오류 참조표로 검증'
        ac.append(f'| {sid} | {", ".join(ids) if ids else reason} |')
    ac += ['', '## 판정 가능한 시나리오', '']
    for c in cases:
        ac += [f'### {c["id"]} · {", ".join(c["screens"])}', '',
               f'- 전제: {c["given"]}.', f'- 동작/사건: {c["action"]}.',
               f'- [ ] **{c["id"]}** [{c["method"]}] 아래 기대를 모두 만족한다.',
               *[f'  - {chr(97+i)}) {part}.' for i,part in enumerate(c['expected'].split('；'))],
               f'- 근거: {c["source"]}; **필수 통과: {c["milestones"]}**.',
               '- 불일치: ' + (', '.join(c['mismatches']) if c['mismatches'] else '없음') + '.', '']
    ac += ['## 불일치 → 판정 항목', '', '| 불일치 | 판정 ID |', '|---|---|']
    for i in range(1,32):
        mid = f'MM-{i:02}'
        ac.append(f'| {mid} | '+', '.join(c['id'] for c in cases if mid in c['mismatches'])+' |')
    replace_generated(HERE/'acceptance.md', '\n'.join(ac), opt.check)

    tokens = ['## 원본 CSS 전체(값의 정본)', '', '줄 번호는 `Main.dc.html`의 원본 줄 번호다. 원본에 토큰 이름이 없는 숫자를 임의의 spacing scale로 정규화하지 않았다.', '', '```css']
    tokens += [f'/* L{i} */ {line}' for i,line in enumerate(lines,1) if 14<=i<=644]
    tokens += ['```', '', '## 템플릿 인라인 스타일 전체', '', '| 원본 줄 | style 값 |', '|---:|---|']
    tokens += [f'| {s["line"]} | {cell(s["value"])} |' for s in p.styles]
    tokens += ['', '## 아이콘 원문', '', '아이콘은 외부 아이콘 패키지 대신 인라인 SVG와 NAV의 path 문자열이다. 아래는 실제 SVG 요소의 원문이다.', '', '```html']
    tokens += [f'<!-- L{i} --> '+m.group(0) for i,line in enumerate(lines,1) if 646<=i<=2902 for m in re.finditer(r'<svg\b.*?</svg>',line)]
    tokens += ['```', '', 'NAV path 원문(3063–3076):', '', '```js'] + lines[3062:3076] + ['```']
    tokens += ['', '## 로직에서 만드는 동적 스타일', '', '스타일·레이아웃 관련 원문 문자열을 포함한 로직 줄이다. 비율/좌표/표 컬럼은 고정 토큰이 아니라 데이터에서 계산한다.', '', '```js']
    tokens += [f'// L{i}\n{line}' for i,line in enumerate(lines,1) if i>=2904 and re.search(r'grid-template|\bstyle\s*:|Style\s*=|cssText|@page',line)]
    tokens += ['```', '', '## 메일 HTML 생성 원문(메일 전용 색·인라인 값 포함)', '',
               '웹 CSS와 별개인 메일 값도 정본에 포함한다. 예: #E1E5EA 경계(P4008).', '', '```js']
    tokens += [f'// L{i}\n{line}' for i,line in enumerate(lines,1) if 4003<=i<=4034]
    tokens += ['```']
    replace_generated(HERE/'design-tokens.md','\n'.join(tokens),opt.check)
    model_path = HERE/'evidence/data-model.json'
    if model_path.exists():
        model = json.loads(model_path.read_text())
        needs = ['## 화면 ID별 조회 데이터와 변경 결과', '', '아래 변경은 **원본 메모리 동작**이다. API 명세가 주어진 경우는 본문 계약 표를 따르고, 없는 경우 경로/HTTP 메서드를 새로 지어내지 않았다. UI만 바꾸는 탭·필터·초안과 영속 데이터 변경은 본문에서 구분한다.', '', '| 화면 ID | 필요한 데이터/입력 | 원본 변경·이동 결과 | 출처 로직 |', '|---|---|---|---|']
        needs += [f'| {r["id"]} {r["title"]} | {cell(r["fields"])} | {cell(" / ".join(r["results"]))} | {r["logic"]} |' for r in records]
        needs += ['', '## 원본 샘플 모델의 전체 필드 경로', '', '추출 방법: `Api.loadProject()` 및 Component 생성자 결과의 모든 중첩 객체·배열을 순회했다. 배열은 `[]`, Task 사전의 키는 `TASK-*`로 정규화했다. null/빈 배열에만 있는 미래 필드는 추론하지 않는다. 예시는 읽기 편의를 위해 각 필드 최대 3개이고, 열거값 전체는 본문과 JSON `constants`가 기준이다. 런타임 날짜·예측값은 실행 시점에 따라 달라진다.', '', '| 필드 경로 | 원본 JS 자료형 | 샘플 값(최대 3) |', '|---|---|---|']
        needs += [f'| {cell(row["path"])} | {cell(", ".join(row["types"]))} | {cell(json.dumps(row["examples"],ensure_ascii=False))} |' for row in model['schema']]
        replace_generated(HERE/'data-needs.md','\n'.join(needs),opt.check)
    # 생성 결과를 별도로 대조: 모든 발생 ID와 화면 ID가 실제 문서에 존재해야 한다.
    inventory = (HERE/'inventory.md').read_text()
    acceptance = (HERE/'acceptance.md').read_text()
    assert set(re.findall(r'EV-\d{4}', inventory)) == {e['id'] for e in p.events}
    assert set(re.findall(r'CD-\d{4}', inventory)) == {c['id'] for c in p.conditions}
    assert set(re.findall(r'LP-\d{4}', inventory)) == {l['id'] for l in p.loops}
    assert len(re.findall(r'^- \[ \]', acceptance, re.M)) == summary['acceptanceTotal']
    assert not re.search(r'^- \[ \].*AC-CD-', acceptance, re.M)
    assert all(f'| {r["id"]} |' in acceptance for r in records)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
