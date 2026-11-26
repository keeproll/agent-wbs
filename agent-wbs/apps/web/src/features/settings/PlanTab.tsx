/**
 * 설정 → 일정 · Task 탭(UI-12-03, P L2451–2510).
 *
 * - 일정에 영향을 주는 저장(재조정 정책·작업 불가일)이 끝나면 일정을 다시 읽는 동안 본문을 흐리게 하고 클릭을 막는다(로딩 5종 「일정 재계산」, UAT-STATE-03).
 * - 작업 불가일은 날짜(YYYY-MM-DD)가 키다. 같은 날짜는 두 번 넣을 수 없고, 해제도 날짜로 찾는다(배열 위치를 쓰지 않음).
 * - 원본 「Agent별 동시 실행 슬롯(최대 5)」 문구는 폐기된 규칙이라 바꿨다(MM-24, UAT-POLICY-04).
 */
import { useContext, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isDateOnly } from '@awbs/shared/api';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import { apiKey } from '../../shared/api/queries.ts';
import { useSessionDraft } from '../../shared/state/useSessionDraft.tsx';
import { ApiError } from '../../shared/api/client.ts';
import { useDim, useErrorBar, useStableCallback } from '../../shared/ui/feedback.tsx';
import { TableScroll } from '../../shared/ui/TableScroll.tsx';
import { hoursLabel, OPTIONS, SPLIT_RULES, STAGES, withValue } from './labels.ts';
import { CardHead, QueryGate, Row, Seg, useSettingQuery } from './ui.tsx';
import { DirtyContext, useSettingForm } from './useSettingForm.tsx';

const pct = (rate: number) => `${String(Math.round(rate * 100))}%`;

export function PlanTab() {
  const queryClient = useQueryClient();
  const { client } = useApi();
  const errorBar = useErrorBar();
  const [owner] = useState(() => Symbol('schedule-refresh'));
  useEffect(() => () => { errorBar.clear(owner); }, [errorBar, owner]);
  const [recalc, setRecalc] = useState(0);
  /** 오류 막대 「다시 시도」가 recalculate를 부르기 위한 참조(선언 순서 때문에 ref로 잇는다, useSave와 같은 방식) */
  const retryRef = useRef<(() => Promise<void>) | null>(null);
  useDim(recalc > 0 ? '일정 다시 계산 중 — 잠시 후 갱신됩니다' : null);
  /** 일정에 영향을 주는 저장 뒤: 일정을 서버에서 다시 읽는 동안 흐리게 한다. */
  const recalculate = useStableCallback(async () => {
    setRecalc((n) => n + 1);
    try {
      // 이 탭에는 일정 query가 없을 수 있어 서버에서 직접 새로 읽고 캐시에 넣는다(대시보드·WBS·Runner 탭이 같은 값을 본다).
      queryClient.setQueryData(apiKey('getSchedule', {}), await client.call('getSchedule', {}));
      errorBar.clear(owner);
    } catch (error) {
      // 설정 저장은 이미 성공했다. 다만 일정 갱신 실패를 숨기면 옛 일정을 새 일정으로 오해한다(리뷰 624c334 지적 6).
      // 그래서 오류 막대와 「다시 시도」로 알린다. 다시 시도는 일정 읽기만 다시 한다.
      if (!(error instanceof ApiError)) throw error;
      if (error.kind !== 'unauthorized') {
        errorBar.show({ owner, error, target: '일정 다시 계산 결과 불러오기', failTitle: '최신 일정을 불러오지 못했습니다', retry: () => { void retryRef.current?.(); } });
      }
    } finally {
      setRecalc((n) => n - 1);
    }
  });
  useEffect(() => { retryRef.current = recalculate; });
  return (
    <>
      <SplitCard />
      <ScheduleCard onScheduleChanged={recalculate} />
      <ProgressCard />
    </>
  );
}

/* ---------------- Task 분할 기준(UI-12-03A, P L2452–2473) ---------------- */

function SplitCard() {
  const { client } = useApi();
  const q = useSettingQuery('getSplitSettings', 'Task 분할 기준', ['settings']);
  const sp = useSettingForm({
    id: 'split',
    label: 'Task 분할 기준',
    ...q,
    toForm: (d) => ({ maxHours: d.maxHours, minHours: d.minHours, maxFiles: d.maxFiles, on: { ...d.on } as Record<string, boolean> }),
    check: (f) => (f.minHours >= f.maxHours ? '크기 하한은 크기 상한보다 작아야 합니다.' : null),
    send: (form, updatedAt, d) => {
      return client.call('putSplitSettings', { body: { updatedAt, ...form, testIn: d.testIn, dir: d.dir } as Parameters<typeof client.call<'putSplitSettings'>>[1]['body'] });
    },
    successNotice: '분할 기준을 바꿨습니다.',
    describe: (f) => `크기 상한 ${hoursLabel(f.maxHours)} · 하한 ${hoursLabel(f.minHours)} · 파일 ${String(f.maxFiles)}개`,
  });
  const f = sp.form;
  return (
    <section className="card" aria-labelledby="set-split">
      <CardHead id="set-split" title="Task 분할 기준" />
      <p className="fhint" style={{ margin: '0 0 8px' }}>Task는 <b>혼자 검증할 수 있고, 혼자 되돌릴 수 있으며, 합쳐도 시스템이 정상 동작하는 가장 작은 변경</b>입니다. 팀장은 기준을 한 번 정하고, Planning Agent가 Task를 식별할 때 적용해 근거를 남기며, Task가 등록 · 수정될 때마다 시스템이 자동 점검합니다.</p>
      {sp.restoreOffer}
      <QueryGate query={q.query} label="Task 분할 기준" />
      {f && (
        <div className="cmp">
          <div className="form">
            <Row label="크기 상한">
              <Seg label="크기 상한" value={f.maxHours} onPick={(v) => { sp.edit((x) => ({ ...x, maxHours: v })); }} options={withValue(OPTIONS.maxHours, f.maxHours).map((n) => ({ value: n, label: hoursLabel(n) }))} />
              <span className="fhint">Agent 실행 시간 기준 — 상한이지 목표가 아닙니다. 상한을 꽉 채울 필요는 없습니다.</span>
            </Row>
            <Row label="크기 하한">
              <Seg label="크기 하한" value={f.minHours} onPick={(v) => { sp.edit((x) => ({ ...x, minHours: v })); }} options={withValue(OPTIONS.minHours, f.minHours).map((n) => ({ value: n, label: hoursLabel(n) }))} />
              <span className="fhint">이보다 작으면 같은 목적 Task와 합치는 것을 검토 (Task마다 QA · Gate 비용이 붙으므로)</span>
            </Row>
            <Row label="바뀌는 파일 상한">
              <Seg label="바뀌는 파일 상한" value={f.maxFiles} onPick={(v) => { sp.edit((x) => ({ ...x, maxFiles: v })); }} options={withValue(OPTIONS.maxFiles, f.maxFiles).map((n) => ({ value: n, label: `${String(n)}개` }))} />
            </Row>
            <Row label="테스트">
              <span><b>Task에 포함</b> <span className="tag">확정</span></span>
              <span className="fhint">Acceptance Criteria를 확인하는 테스트는 그 Task 안에서 작성 — 별도 Task로 빼면 혼자 검증할 수 없게 됨</span>
            </Row>
            <Row label="나누는 방향">
              <span><b>계층별 · 계약 먼저 (A)</b> <span className="tag">확정</span></span>
              <span className="fhint">여러 계층에 걸친 기능: API 계약 정의 → DB → API 구현 → UI(계약 기반 Mock으로 검증) → 연결 확인. 계층 하나로 끝나는 작은 기능만 세로 단위 예외 허용</span>
            </Row>
          </div>
          <div>
            <TableScroll minWidth={520} label="분할 10규칙 표">
              <div className="gtb" style={{ margin: 0 }}>
                <div className="gtr h" style={{ gridTemplateColumns: '40px minmax(0,1fr) 120px 110px', minWidth: 0 }}><span className="gc">#</span><span className="gc">기준</span><span className="gc">점검 방식</span><span className="gc">사용</span></div>
                {SPLIT_RULES.map((rule, i) => {
                  const on = f.on[rule.key] ?? true;
                  return (
                    <div key={rule.key} className="gtr" style={{ gridTemplateColumns: '40px minmax(0,1fr) 120px 110px', minWidth: 0 }}>
                      <span className="gc mono">{i + 1}</span>
                      <span className="gc"><b>{rule.label}</b><br /><span className="muted">{rule.desc}</span></span>
                      <span className="gc">{rule.how === 'auto' ? '자동 점검' : 'Planning Agent 판단 기록'}</span>
                      <span className="gc"><span className={on ? 'sc sc-ok' : 'sc sc-none'}>{on ? '사용' : '꺼짐'}</span> <button type="button" className="btn ghost sm" aria-label={`${rule.label} ${on ? '끄기' : '켜기'}`} onClick={() => { sp.edit((x) => ({ ...x, on: { ...x.on, [rule.key]: !on } })); }}>{on ? '끄기' : '켜기'}</button></span>
                    </div>
                  );
                })}
              </div>
            </TableScroll>
          </div>
        </div>
      )}
      {sp.footer}
    </section>
  );
}

/* ---------------- 일정 재조정 정책 · 작업 불가일(UI-12-03B, P L2474–2493) ---------------- */

function ScheduleCard({ onScheduleChanged }: { onScheduleChanged: () => Promise<void> }) {
  const { client } = useApi();
  const pq = useSettingQuery('getScheduleSettings', '일정 재조정 정책');
  const pol = useSettingForm({
    id: 'schedule-policy',
    label: '일정 재조정 정책',
    ...pq,
    toForm: (d) => ({ autoReplan: d.autoReplan, cpAuto: d.cpAuto, thresholdDays: d.thresholdDays, assumeRate: d.assumeRate }),
    send: (form, updatedAt, d) => {
      return client.call('putScheduleSettings', { body: { updatedAt, ...form, windowDays: d.windowDays, minHours: d.minHours } });
    },
    afterSave: onScheduleChanged,
    describe: (f) => `재조정 ${f.autoReplan ? '자동 반영' : '제안만'} · 임계값 ${String(f.thresholdDays)}일 · 가정 가동률 ${pct(f.assumeRate)}`,
  });
  const bq = useSettingQuery('getBlackouts', '작업 불가일', ['settings', 'schedule']);
  const bo = useSettingForm({
    id: 'blackouts',
    label: '작업 불가일',
    ...bq,
    toForm: (d) => ({ days: d.days.map((x) => ({ date: x.date, note: x.note })) }),
    send: (form, updatedAt) => client.call('putBlackouts', { body: { updatedAt, days: form.days } }),
    afterSave: onScheduleChanged,
    successNotice: '작업 불가일을 저장했습니다 — 일정을 다시 계산합니다.',
    describe: (f) => `작업 불가일 ${String(f.days.length)}일: ${f.days.map((x) => x.date).join(', ')}`,
  });
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  // 아직 「추가」하지 않은 날짜·사유도 입력이다(리뷰 624c334 지적 5). 이동 전에 묻고, 세션 만료 때 보관한다.
  const typing = date !== '' || note !== '';
  const report = useContext(DirtyContext);
  useEffect(() => { report('blackouts-input', typing); }, [report, typing]);
  useEffect(() => () => { report('blackouts-input', false); }, [report]);
  const { restoreOffer: inputOffer } = useSessionDraft<{ date: string; note: string }>({
    id: 'settings:blackouts-input',
    label: '설정 — 작업 불가일 추가 입력',
    value: typing ? { date, note } : null,
    onRestore: (data) => { setDate(data.date); setNote(data.note); },
  });
  const p = pol.form;
  const days = bo.form?.days ?? [];
  const add = () => {
    const value = date.trim();
    if (!value) { setError('날짜를 입력하세요.'); return; }
    if (!isDateOnly(value)) { setError('날짜 형식이 아닙니다 — YYYY-MM-DD로 입력하세요(예: 2026-12-24).'); return; }
    if (days.some((x) => x.date === value)) { setError(`${value}는 이미 작업 불가일입니다.`); return; }
    bo.edit((x) => ({ days: [...x.days, { date: value, note: note.trim() }].sort((a, b) => a.date.localeCompare(b.date)) }));
    setDate(''); setNote(''); setError('');
  };
  return (
    <section className="card" aria-labelledby="set-sched">
      <CardHead id="set-sched" title="일정 재조정 정책 · 작업 불가일"><span className="fhint">팀장 개입 최소화 — Agent 합의 결과를 일정에 자동 반영</span></CardHead>
      {pol.restoreOffer}{bo.restoreOffer}{inputOffer}
      <div className="cmp">
        <div>
          <QueryGate query={pq.query} label="일정 재조정 정책" />
          {p && (
            <div className="form">
              <Row label="일정 재조정">
                <Seg label="일정 재조정" value={p.autoReplan} onPick={(v) => { pol.edit((x) => ({ ...x, autoReplan: v })); }} options={[{ value: true, label: '자동 반영' }, { value: false, label: '제안만 생성' }]} />
                <span className="fhint">Task 추가 · 삭제 · 재추정, Runner 중단, 사용량 한도가 생기면 Planning Agent가 전체 일정을 다시 계산해 새 기준 일정 버전으로 반영합니다.</span>
              </Row>
              <Row label="Change Proposal">
                <Seg label="Change Proposal" value={p.cpAuto} onPick={(v) => { pol.edit((x) => ({ ...x, cpAuto: v })); }} options={[{ value: true, label: 'Agent 합의 시 자동 승인 · 반영' }, { value: false, label: '팀장 승인 필요' }]} />
                <span className="fhint">Codex · Claude가 합의한 범위 변경과 팀장 지시는 영향 분석 후 바로 WBS에 반영합니다. 문제(순환 · 완료 Task 변경 등)가 있으면 반영을 보류합니다.</span>
              </Row>
              <Row label="재조정 임계값">
                <Seg label="재조정 임계값" value={p.thresholdDays} onPick={(v) => { pol.edit((x) => ({ ...x, thresholdDays: v })); }} options={withValue(OPTIONS.thresholdDays, p.thresholdDays).map((n) => ({ value: n, label: `${String(n)}일` }))} />
                <span className="fhint">가동률 변화만으로 완료 예상이 기준에서 이만큼 벗어나면 새 기준 버전을 만듭니다. 기본값 1일.</span>
              </Row>
              <Row label="초기 가동률 가정">
                <Seg label="초기 가동률 가정" value={p.assumeRate} onPick={(v) => { pol.edit((x) => ({ ...x, assumeRate: v })); }} options={withValue(OPTIONS.assumeRate, p.assumeRate).map((n) => ({ value: n, label: pct(n) }))} />
                <span className="fhint">가동 기록이 72시간 미만일 때만 사용합니다. 기본값 60%.</span>
              </Row>
            </div>
          )}
          {pol.footer}
        </div>
        <div>
          <h3 className="h4">작업 불가일 <span className="muted" style={{ fontWeight: 400 }}>PC를 켤 수 없는 날 — 해당 날짜는 가용 용량 0</span></h3>
          <QueryGate query={bq.query} label="작업 불가일" />
          {bo.form && (
            <>
              <div className="gtb" style={{ marginBottom: 8 }}>
                {days.map((b) => (
                  <div key={b.date} className="gtr" style={{ gridTemplateColumns: '110px minmax(120px,1fr) 60px', minWidth: 0 }}>
                    <span className="gc mono">{b.date}</span><span className="gc">{b.note}</span>
                    <span className="gc"><button type="button" className="btn ghost sm" aria-label={`${b.date} 해제`} onClick={() => { bo.edit((x) => ({ days: x.days.filter((y) => y.date !== b.date) })); }}>해제</button></span>
                  </div>
                ))}
                {days.length === 0 && <div className="gtr"><span className="gc muted">등록된 작업 불가일이 없습니다. 휴가 · 점검처럼 PC를 켤 수 없는 날을 아래에서 추가하면 그날은 일정 계산에서 빠집니다.</span></div>}
              </div>
              <div className="addbox-r">
                <label className="sr" htmlFor="bo-d">날짜</label>
                <input id="bo-d" className="inp mono-in" style={{ width: 130 }} placeholder="YYYY-MM-DD" value={date} onChange={(e) => { setDate(e.target.value); setError(''); }} />
                <label className="sr" htmlFor="bo-n">사유</label>
                <input id="bo-n" className="inp" style={{ flex: 1, minWidth: 140 }} placeholder="사유 (선택)" value={note} onChange={(e) => { setNote(e.target.value); }} />
                <button type="button" className="btn sm" onClick={add}>추가</button>
              </div>
              {error && <span className="ferr" role="alert">{error}</span>}
            </>
          )}
          {bo.footer}
        </div>
      </div>
    </section>
  );
}

/* ---------------- 일정 · 진행률 산정 기준(UI-12-03C, P L2494–2510, 읽기 전용) ---------------- */

function ProgressCard() {
  return (
    <section className="card" aria-labelledby="set-prog">
      <CardHead id="set-prog" title="일정 · 진행률 산정 기준" />
      <div className="cmp">
        <ul className="lst">
          <li><b>작업량</b> = Agent 실행 시간(세션 활성 시간, 개발 · QA · 재작업 포함). Planning Agent가 Prototype 분석 후 예상 · 낙관 · 비관 값과 예상 토큰, 근거를 함께 등록합니다.</li>
          {/* MM-24: 원본 「Agent별 동시 실행 슬롯(최대 5)」은 폐기된 고정값이라 실제 규칙(팀장 상한 + Runner 조절)으로 바꿨다. */}
          <li><b>배치</b>: 선행 관계(FS · SS)와 우선순위를 지키며 동시 실행 한도(팀장 상한 안에서 Runner가 조절) 안에서 배정합니다. 사용량 한도에 걸린 Agent는 리셋 시각까지 배정하지 않습니다.</li>
          <li><b>날짜 환산</b>: 관측 가동률(최근 7일)로 하루 가용 시간을 계산하고, 작업 불가일은 0으로 봅니다. 완료 예상은 중간값과 범위(낙관 작업량 × 높은 가동률 ~ 비관 작업량 × 낮은 가동률)로 표시합니다.</li>
          <li><b>기준 일정</b>은 재조정 때마다 새 버전(v1, v2 …)으로 남고, 「기준 대비」는 최신 버전과 비교합니다. 실제 시작 = 첫 실행 요청, 실제 완료 = Completion Gate 완료 처리.</li>
          <li><b>진행률</b> = Σ(작업량 × 상태 단계 가중치) ÷ Σ작업량 · <b>완료율</b> = 완료 Task 수 ÷ 전체 Task 수 (취소 제외).</li>
        </ul>
        <div className="gtb" style={{ margin: 0 }}>
          <div className="gtr h" style={{ gridTemplateColumns: 'minmax(140px,1fr) 100px', minWidth: 0 }}><span className="gc">Task 상태</span><span className="gc">진행률 가중치</span></div>
          {STAGES.map((s) => (
            <div key={s.key} className="gtr" style={{ gridTemplateColumns: 'minmax(140px,1fr) 100px', minWidth: 0 }}>
              <span className="gc"><span className={`st ${s.cls}`}><span className="st-d" aria-hidden="true" />{s.label}</span></span>
              <span className="gc mono">{s.pct}%</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
