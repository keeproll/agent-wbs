/**
 * 설정 → 점검 탭(UI-12-06, P L2646–2673).
 *
 * - 제품에는 데이터 정합성 점검만 있다(G L346, UAT-POLICY-05). 원본의 「Prototype 구현 현황」·「화면 상태 미리보기」·「Mock 지연」은 만들지 않는다(D-17·D-23).
 * - 「점검 실행」은 서버가 지금 데이터로 다시 계산한 결과(GET /api/system/integrity)를 받는다. 누르기 전에는 아무것도 부르지 않는다.
 */
import { useState } from 'react';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import type { ResponseOf } from '../../shared/api/contract.ts';
import { formatDateTime } from '../../shared/format.ts';
import { useSave } from '../../shared/state/useSave.tsx';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { TableScroll } from '../../shared/ui/TableScroll.tsx';
import { CardHead } from './ui.tsx';

export function SystemTab() {
  const { client } = useApi();
  const [result, setResult] = useState<ResponseOf<'getIntegrity'> | null>(null);
  // 읽기 요청이지만 버튼 진행 표시·실패 막대·다시 시도 규칙을 같게 하려고 useSave를 쓴다.
  const run = useSave<ResponseOf<'getIntegrity'>>({
    target: '데이터 정합성 점검',
    failTitle: '점검하지 못했습니다',
    run: () => client.call('getIntegrity', {}),
    onSuccess: (data) => { setResult(data); },
  });
  const passed = result?.items.filter((i) => i.ok).length ?? 0;
  const allOk = result !== null && passed === result.items.length;
  return (
    <section className="card" aria-labelledby="set-check">
      <CardHead id="set-check" title="데이터 정합성 · 회귀 점검">
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {result && (
            <>
              <span className={allOk ? 'vf v-pass' : 'vf v-fail'}>{`${String(passed)} / ${String(result.items.length)} 통과`}</span>
              <span className="mono muted">{formatDateTime(result.checkedAt)}</span>
            </>
          )}
          <BusyButton small busy={run.busy} busyLabel="점검 중…" onClick={() => { void run.save(); }}>점검 실행</BusyButton>
        </span>
      </CardHead>
      <p className="fhint" style={{ margin: '0 0 8px' }}>저장된 데이터에 대해 Task ID 참조, 의존성, Completion Gate, 메시지 상태, Change Proposal 반영 여부를 다시 계산합니다. 작업을 진행한 뒤 실행해 회귀 여부를 확인하세요.</p>
      <TableScroll minWidth={640} label="정합성 점검 결과 표">
        <div className="gtb">
          <div className="gtr h" style={{ gridTemplateColumns: '80px minmax(260px,1fr) minmax(200px,1fr)' }}><span className="gc">결과</span><span className="gc">점검 항목</span><span className="gc">상세</span></div>
          {result === null && <div className="gtr"><span className="gc muted">아직 점검하지 않았습니다. 「점검 실행」을 누르세요.</span></div>}
          {result?.items.length === 0 && <div className="gtr"><span className="gc muted">점검할 항목이 없습니다.</span></div>}
          {result?.items.map((item) => (
            <div key={item.key} className="gtr" style={{ gridTemplateColumns: '80px minmax(260px,1fr) minmax(200px,1fr)' }}>
              <span className="gc"><span className={item.ok ? 'vf v-pass' : 'vf v-fail'}>{item.ok ? 'PASS' : 'FAIL'}</span></span>
              <span className="gc">{item.label}</span>
              <span className="gc mono">{item.detail}</span>
            </div>
          ))}
        </div>
      </TableScroll>
    </section>
  );
}
