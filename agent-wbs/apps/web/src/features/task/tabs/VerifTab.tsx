/** 검증·Evidence 탭(UI-03-07) — 원본 P L1319–1336. QA 결과 등록은 [작업 실행], Evidence 통합 관리는 다른 화면이다. */
import type { UseQueryResult } from '@tanstack/react-query';
import type { ApiError } from '../../../shared/api/client.ts';
import type { ResponseOf } from '../../../shared/api/contract.ts';
import { formatDateTime } from '../../../shared/format.ts';
import { AreaLoading } from '../../../shared/ui/loading.tsx';
import { agCls, agInit, RESULT_CLASS, type TaskDetailData } from '../labels.ts';

type Verifications = UseQueryResult<ResponseOf<'getTaskVerifications'>, ApiError>;
type Evidence = ResponseOf<'listEvidence'>['items'][number];

export function VerifTab({ task: t, verifications, evidence }: { task: TaskDetailData; verifications: Verifications; evidence: Evidence[] }) {
  const vers = verifications.data?.items ?? [];
  const ag = t.verifierAgent === null ? '' : String(t.verifierAgent);
  return (
    <div className="pane">
      <div className="pane-h"><div className="pane-hl"><h3>검증·Evidence</h3><span className="muted">Verification Result와 연결된 Evidence</span></div><span className="tag">QA 결과 등록은 [작업 실행] · Evidence 통합 관리는 Phase D</span></div>
      {verifications.data === undefined && <AreaLoading label="검증 결과 불러오는 중" />}
      {verifications.data !== undefined && !vers.length && <p className="empty">검증 결과가 없습니다.</p>}
      {vers.map((v, i) => {
        const r = String(v.result);
        const evs = evidence.filter((e) => e.verificationId === v.id);
        return (
          <div className="att" key={v.id} role="article" aria-label={`검증 ${String(i + 1)} ${r}`}>
            <div className="att-h">
              <span className="att-n mono">VR-{String(i + 1).padStart(3, '0')}</span><span className={`vf ${RESULT_CLASS[r] ?? 'v-none'}`}>{r}</span>
              {ag && <span className="agent"><span className={`ag-mk ${agCls(ag)}`} aria-hidden="true">{agInit(ag)}</span>{ag}</span>}
              <span className="muted">대상 커밋 <span className="mono">{v.headSha.slice(0, 7)}</span> · 명세 r{v.specRevision}</span>
              {v.invalidated && <span className="sc sc-warn">무효 — 명세 · 코드 변경 후 재검증 필요</span>}
              <span className="mono muted">{formatDateTime(v.at)}</span>
            </div>
            <div className="ev">
              <span className="ev-l">테스트 명령</span><span><code>{v.cmd}</code></span>
              <span className="ev-l">예상 결과</span><span>{v.expected}</span>
              <span className="ev-l">실제 결과</span><span>{v.actual}</span>
              <span className="ev-l">Evidence</span>
              {evs.length ? <ul className="lst mono-list" style={{ margin: 0 }}>{evs.map((e) => <li key={e.id}><a href={`/api/evidence/${e.id}/content`}>{e.kind} · {e.sha256.slice(0, 12)} · {String(e.size)}B</a></li>)}</ul> : <span className="muted">없음</span>}
              {v.defects.length > 0 && <><span className="ev-l">결함·재작업 사유</span><ul className="lst" style={{ margin: 0, color: '#8A1C12' }}>{v.defects.map((d) => <li key={d.defKey}>{d.defKey} {d.text}{d.blocking ? ' (차단)' : ''}{d.resolved ? ' — 해결됨' : ''}</li>)}</ul></>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
