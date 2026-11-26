/**
 * MOD-05 프로젝트 초기화 창(P L2762–2784). 「프로젝트 초기화…」와 「등록 취소 (초기화)」가 연다.
 *
 * - 삭제 건수·Runner 정리 내용은 서버 미리보기(GET /api/project/reset-preview)를 그대로 보인다(원본의 화면 계산 대신).
 * - 프로젝트 이름을 그대로 입력해야 「모두 삭제하고 초기화」가 눌린다. 서버도 이름을 다시 확인한다.
 * - 요청에는 화면이 본 초기화 번호(epoch)를 넣는다. 그사이 다른 초기화가 있었으면 409 EPOCH_MISMATCH로 거부된다.
 * - 내보내기는 선택이다. 서버가 만든 zip을 브라우저가 내려받는다(비밀값·메일 수신자 제외, contracts §2.2).
 * - 원본 문구 「원본 입력 파일(프로토타입 zip · 설계 문서)」은 폐기된 zip 흐름의 잔재라 prototype/ 안내로 바꿨다(MM-23, UAT-RESET-01).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import { ApiError, apiUrl } from '../../shared/api/client.ts';
import type { ResponseOf } from '../../shared/api/contract.ts';
import { invalidateTopics, useApiQuery } from '../../shared/api/queries.ts';
import { useSave } from '../../shared/state/useSave.tsx';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { canRetry, causeMessage, causeTitle, codeLabel } from '../../shared/ui/errors.ts';
import { useNotice } from '../../shared/ui/feedback.tsx';
import { ICON, Icon } from '../../shared/ui/Icon.tsx';
import { AreaLoading } from '../../shared/ui/loading.tsx';
import { Modal } from '../../shared/ui/Modal.tsx';
import { shortSha, type RegisteredProject } from './labels.ts';

type Preview = ResponseOf<'previewReset'>;

export function resetCounts(p: Preview): [string, number][] {
  const c = p.counts;
  return [['Task', c.tasks], ['실행 시도', c.attempts], ['검증 결과', c.verifications], ['Evidence 파일', c.evidence], ['Change Proposal', c.proposals],
    ['메시지', c.messages], ['이력', c.history], ['보고서', c.reports], ['기준 일정 버전', c.baselines], ['입력 자료 버전', c.inputs]];
}

export function runnerJobs(p: Preview): string[] {
  const br = p.runner.branches;
  return [
    `실행 중 Agent 세션 ${String(p.counts.running)}개 종료 (하위 Agent ${String(p.counts.subagents)}개 포함)`,
    `worktree ${String(p.runner.worktrees)}개 삭제`,
    `Agent 브랜치 ${String(br.length)}개 삭제${br.length ? ` (${br.slice(0, 4).join(', ')}${br.length > 4 ? ' …' : ''})` : ''}`,
    p.repo.baseCommit
      ? `GitHub main에 되돌림 커밋 — src/ · contracts/ · .agentwbs/ 를 등록 시점 기준 커밋 ${shortSha(p.repo.baseCommit)} 상태로 (병합된 코드 ${String(p.runner.mergedTasks)}건 분량). 강제 push는 하지 않고, prototype/ (uiux · docs) 입력은 그대로 둡니다`
      : '기준 커밋이 기록되지 않아 저장소 되돌림은 하지 않습니다',
    'GitHub의 Agent 브랜치 삭제 · 열린 Agent PR 닫기',
    '작업 대기열 · 입력 checkout 사본 · 실행 로그 · 임시 파일 삭제',
  ];
}

export function ResetModal({ project, onClose }: { project: RegisteredProject; onClose: () => void }) {
  const { client } = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const notify = useNotice();
  const preview = useApiQuery('previewReset', {}, { topics: ['project'], keepPrevious: false });
  const runner = useApiQuery('getRunnerState', {}, { topics: ['runner'] });
  const online = runner.data?.connection.online !== false;
  const [keep, setKeep] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const name = preview.data?.projectName ?? project.name;
  const matches = confirmName.trim() === name;
  /**
   * 마지막 실패. 오류 막대(앱 틀)는 모달 overlay 아래에 있어 모달이 열린 동안 「다시 시도」를 누를 수 없다.
   * 그래서 모달 안에도 같은 원인·조치와 「다시 시도」를 보인다. 다시 시도는 save()라 같은 요청 내용·멱등 키로 간다.
   */
  const [failure, setFailure] = useState<ApiError | null>(null);

  const reset = useSave<ResponseOf<'resetProject'>, { confirmName: string; keepSettings: boolean; epoch: number }>({
    target: '프로젝트 초기화',
    failTitle: '초기화하지 못했습니다',
    request: () => ({ confirmName: confirmName.trim(), keepSettings: keep, epoch: preview.data?.epoch ?? project.epoch }),
    run: async ({ payload, idempotencyKey }) => {
      setFailure(null);
      try { return await client.call('resetProject', { body: payload, idempotencyKey }); }
      catch (error) { if (error instanceof ApiError && error.kind !== 'unauthorized') setFailure(error); throw error; }
    },
    onSuccess: () => {
      onClose();
      notify(online
        ? '프로젝트를 초기화했습니다. Runner가 정리를 마치면 초기화 기록에 「정리 완료」가 남습니다. 새 프로젝트를 등록할 수 있습니다.'
        : '프로젝트를 초기화했습니다. Runner가 연결되어 있지 않아 Runner 정리는 다시 연결될 때 실행됩니다. 그전에는 초기 분석이 시작되지 않습니다.');
      void invalidateTopics(queryClient, 'all');
      void navigate('/project');
    },
    // EPOCH_MISMATCH 등: 화면이 본 상태가 낡았다. 미리보기와 프로젝트를 다시 읽는다.
    onRejected: () => { void invalidateTopics(queryClient, ['project']); },
  });

  const footer = (
    <>
      <button type="button" className="btn" onClick={onClose}>취소</button>
      <BusyButton variant="danger" busy={reset.busy} busyLabel="Runner 정리 · 삭제 중…" disabled={!matches || !preview.data} onClick={() => { void reset.save(); }}>모두 삭제하고 초기화</BusyButton>
    </>
  );
  return (
    <Modal
      title={`프로젝트 초기화 — 「${name}」`}
      meta={<button type="button" className="iconbtn" aria-label="닫기" onClick={onClose}><Icon d={ICON.close} /></button>}
      footer={footer}
      onCancel={onClose}
      size="lg"
      role="dialog"
      style={{ width: 'min(820px,100%)' }}
      initialFocus="#rs-confirm"
    >
      <div className="banner danger"><div className="banner-b"><b>초기화하면 진행 중인 모든 작업이 중지되고, 지금까지의 기록 · 결과 · 산출물이 모두 삭제됩니다.</b> Agent WBS와 Runner는 프로젝트 등록 전 상태로 돌아가며, 삭제된 내용은 복구할 수 없습니다. 아래 삭제 항목을 확인한 뒤 진행하세요.</div></div>
      {preview.data ? (
        <div className="cmp" style={{ marginTop: 12 }}>
          <div><h4 style={{ marginTop: 0 }}>Agent WBS에서 삭제</h4><div className="rs-grid" data-testid="reset-counts">{resetCounts(preview.data).map(([l, n]) => <span key={l} style={{ display: 'contents' }}><span>{l}</span><b className="mono">{n}</b></span>)}</div></div>
          <div><h4 style={{ marginTop: 0 }}>Runner · 작업 저장소에서 정리</h4><ul className="lst" style={{ margin: 0, paddingLeft: 18 }} data-testid="reset-runner">{runnerJobs(preview.data).map((t) => <li key={t}>{t}</li>)}</ul></div>
        </div>
      ) : preview.isError
        ? <div className="banner danger" style={{ marginTop: 12 }}><div className="banner-b">삭제 항목을 불러오지 못했습니다. 삭제 건수를 확인하기 전에는 초기화할 수 없습니다. <button type="button" className="btn sm" onClick={() => { void preview.refetch(); }}>다시 시도</button></div></div>
        : <AreaLoading label="삭제 항목 불러오는 중" />}
      <p className="fhint" style={{ margin: '10px 0' }}>삭제하지 않음: 입력 자료(prototype/ (uiux · docs) — GitHub에 그대로), GitHub 연결 설정, 등록 이전부터 저장소에 있던 코드, 초기화 기록 한 줄(언제 · 누가 — 프로젝트 데이터와 별도).</p>
      {!online && <div className="banner warn"><div className="banner-b">Runner가 연결되어 있지 않습니다. Agent WBS 데이터는 바로 삭제되고, Runner 정리는 다시 연결될 때 실행됩니다. 그전까지 이전 작업의 보고는 초기화 번호가 달라 거부되고, 새 초기 분석은 시작되지 않습니다.</div></div>}
      {failure && (
        <div className="banner danger" data-testid="reset-fail" style={{ marginTop: 10 }}><div className="banner-b">
          <b>초기화하지 못했습니다 — {causeTitle(failure)}</b> <span className="mono">{codeLabel(failure)}</span>
          <div style={{ marginTop: 4 }}>{causeMessage(failure)}</div>
          {canRetry(failure) && <div className="msg-acts" style={{ marginTop: 6 }}><BusyButton small busy={reset.busy} busyLabel="다시 시도 중…" onClick={() => { void reset.save(); }}>다시 시도</BusyButton></div>}
        </div></div>
      )}
      <div className="form" style={{ marginTop: 10 }}>
        <div className="frow"><span className="flabel">설정 · 실행 환경</span><div className="fctl">
          <div className="seg" role="group" aria-label="설정 · 실행 환경">
            <button type="button" aria-pressed={!keep} onClick={() => { setKeep(false); }}>함께 삭제 (기본)</button>
            <button type="button" aria-pressed={keep} onClick={() => { setKeep(true); }}>설정 유지</button>
          </div>
          <span className="fhint">{keep ? '유지: 동시 실행 상한 · 실행 정책 · 일정 재조정 정책 · 작업 불가일 · 실행 PC 사양 · 세션 메모리 관측 · Runner 가동 기록' : '삭제: 위 설정과 측정값도 기본값으로 돌아갑니다. Runner가 다시 연결되면 PC 사양을 새로 보고합니다.'}</span>
        </div></div>
        <div className="frow"><span className="flabel">초기화 전 내보내기</span><div className="fctl">
          <a className="btn sm" href={apiUrl('exportProject', {})} download>데이터 내보내기 (선택)</a>
          <span className="fhint">zip 파일(데이터 JSON · 보고서 PDF · Evidence)로 받습니다. 비밀값과 메일 받는 사람은 들어가지 않습니다. 받지 않아도 진행할 수 있습니다.</span>
        </div></div>
        <div className="frow"><label className="flabel" htmlFor="rs-confirm">확인 입력 <span className="req">*</span></label><div className="fctl">
          <input id="rs-confirm" className="inp" placeholder={name} value={confirmName} onChange={(e) => { setConfirmName(e.target.value); }} aria-describedby="rs-confirm-h" />
          <span id="rs-confirm-h" className="fhint">{confirmName && !matches ? '프로젝트 이름을 정확히 입력해야 초기화됩니다.' : '프로젝트 이름을 그대로 입력하세요.'}</span>
        </div></div>
      </div>
    </Modal>
  );
}
