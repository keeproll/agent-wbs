/**
 * 착수 승인 요청·승인·반려(UAT-APPROVE-01, owner Q-02/Q-05 #2·#3, contracts §2.1).
 *
 * 원본에는 Task 착수 승인 화면이 없다(원본은 상태만 「승인 대기」로 보인다). 그래서 원본의 띠(`.banner`)와
 * 버튼(`.btn`)만 조합해 상세 머리에 둔다. 새 모양은 만들지 않는다.
 * - planning: 「착수 승인 요청」. 명세 필수 항목이 비면 서버가 400 errors[]로 거부하고, 오류 막대가 고칠 항목을 보인다.
 * - approval: 「승인」(→ ready)·「반려」(→ planning). 반려는 사유를 받는다.
 * - 승인만으로 실행하거나 완료하지 않는다. 실행은 [작업 실행]에서 따로 요청한다.
 */
import { useState } from 'react';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { Modal } from '../../shared/ui/Modal.tsx';
import type { TaskDetailData } from './labels.ts';
import { useApiClient, useTaskSave } from './useTaskData.ts';

/**
 * approveTask·rejectTask는 계약에서 `${action}Task` 템플릿으로 만들어져 TypeScript가 id를 좁히지 못한다(타입이 never, 보고함).
 * 두 요청의 본문·응답 모양은 requestTaskApproval과 같으므로 그 타입을 빌려 쓴다. 실제 경로는 id로 찾으므로 올바르게 간다.
 */
const APPROVE = 'approveTask' as 'requestTaskApproval';
const REJECT = 'rejectTask' as 'requestTaskApproval';

export function ApprovalBar({ task }: { task: TaskDetailData }) {
  const client = useApiClient();
  const status = String(task.lifecycleStatus);
  const params = { taskKey: task.taskKey };
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const request = useTaskSave(task.taskKey, {
    target: `${task.taskKey} 착수 승인 요청`, failTitle: '착수 승인을 요청하지 못했습니다',
    run: ({ idempotencyKey, updatedAt }) => client.call('requestTaskApproval', { params, body: { updatedAt }, idempotencyKey }),
    successNotice: `${task.taskKey} 착수 승인을 요청했습니다. 팀장 승인 대기 상태입니다.`,
  });
  const approve = useTaskSave(task.taskKey, {
    target: `${task.taskKey} 착수 승인`, failTitle: '착수 승인하지 못했습니다',
    run: ({ idempotencyKey, updatedAt }) => client.call(APPROVE, { params, body: { updatedAt }, idempotencyKey }),
    successNotice: `${task.taskKey} 착수를 승인했습니다. 실행 대기 상태입니다 — 실행은 [작업 실행]에서 요청합니다.`,
  });
  const reject = useTaskSave(task.taskKey, {
    target: `${task.taskKey} 착수 반려`, failTitle: '착수 반려하지 못했습니다',
    request: () => reason.trim(),
    run: ({ idempotencyKey, updatedAt, payload }) => client.call(REJECT, { params, body: { updatedAt, ...(payload ? { comment: payload } : {}) }, idempotencyKey }),
    onSuccess: () => { setRejecting(false); setReason(''); },
    successNotice: `${task.taskKey} 착수를 반려했습니다. 계획 중 상태로 돌아갔습니다.`,
  });
  const busy = request.busy || approve.busy || reject.busy;

  if (status === 'planning') {
    return (
      <div className="banner info appr-bar">
        <div className="banner-b"><b>계획 중</b> — 작업 목적 · 완료 조건 · Acceptance Criteria · 체크리스트 · 필수 산출물 · 담당/검증 Agent를 채운 뒤 착수 승인을 요청합니다.</div>
        <BusyButton small busy={request.busy} busyLabel="요청 중…" disabled={busy} onClick={() => { void request.save(); }}>착수 승인 요청</BusyButton>
        {request.conflictModal}
      </div>
    );
  }
  if (status !== 'approval') return null;
  return (
    <div className="banner warn appr-bar">
      <div className="banner-b"><b>착수 승인 대기</b> — 승인하면 실행 대기, 반려하면 계획 중으로 돌아갑니다. 착수 승인만으로 실행하거나 완료하지 않습니다.</div>
      <span className="appr-acts">
        <BusyButton small variant="default" busy={reject.busy} busyLabel="반려 중…" disabled={busy} onClick={() => { setRejecting(true); }}>반려</BusyButton>
        <BusyButton small busy={approve.busy} busyLabel="승인 중…" disabled={busy} onClick={() => { void approve.save(); }}>승인</BusyButton>
      </span>
      {approve.conflictModal}
      {reject.conflictModal}
      {rejecting && (
        <Modal
          title="착수 반려" role="dialog" onCancel={() => { setRejecting(false); }}
          footer={<><span className="sp" /><button type="button" className="btn" onClick={() => { setRejecting(false); }}>취소</button><BusyButton variant="danger" busy={reject.busy} busyLabel="반려 중…" onClick={() => { void reject.save(); }}>반려</BusyButton></>}
        >
          <p style={{ marginTop: 0 }}>{task.taskKey} {task.title}의 착수를 반려합니다. 계획 중으로 돌아가며 사유는 이력에 남습니다.</p>
          <label className="flabel" htmlFor="reject-reason">반려 사유<span className="opt">선택</span></label>
          <textarea id="reject-reason" className="inp" rows={3} style={{ width: '100%' }} value={reason} onChange={(e) => { setReason(e.target.value); }} />
        </Modal>
      )}
    </div>
  );
}
