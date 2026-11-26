/** 설정 → 보고서 · 메일 탭 계산(M6-03). 원본 P addRecip·saveSmtp·mailVM 규칙 */
import { describe, expect, test } from 'vitest';
import { BLANK_RECIPIENT, lastSend, recipientError, recipientSummary, smtpError, stateLabel, type MailLog, type Recipient } from '../src/features/settings/report/model.ts';

const rc = (email: string, over: Partial<Recipient> = {}): Recipient => ({ id: email, email, name: '', daily: true, weekly: false, view: 'int', pdf: false, active: true, createdAt: '2026-11-04T00:00:00.000000Z', updatedAt: '2026-11-04T00:00:00.000000Z', ...over });
const lg = (over: Partial<MailLog>): MailLog => ({
  id: 'l', logKey: 'ML-0001', reportId: 'r', reportKey: 'RPT-W-261026', pdf: false, pending: false, recipientId: 'qa@example.com', to: 'qa@example.com', subject: 's', view: 'int',
  tryNo: 1, state: 'accepted', error: null, reason: '정기 발송', at: '2026-11-04T00:00:00.000000Z', ...over,
});

describe('받는 사람 추가 검사(P addRecip L4936)', () => {
  test('비었음 → 형식 → 중복(대소문자 무시) → 구독 없음 순서로 알린다', () => {
    expect(recipientError({ ...BLANK_RECIPIENT, email: ' ' }, [])).toBe('이메일 주소를 입력하세요.');
    expect(recipientError({ ...BLANK_RECIPIENT, email: 'qa@' }, [])).toBe('이메일 형식이 올바르지 않습니다 — 예: name@example.com');
    expect(recipientError({ ...BLANK_RECIPIENT, email: 'QA@Example.com' }, [rc('qa@example.com')])).toBe('이미 등록된 주소입니다.');
    expect(recipientError({ ...BLANK_RECIPIENT, email: 'qa@example.com', daily: false, weekly: false }, [])).toBe('일간 · 주간 중 하나 이상 선택하세요.');
    expect(recipientError({ ...BLANK_RECIPIENT, email: 'qa@example.com' }, [])).toBe('');
  });
});

describe('SMTP 저장 검사(P saveSmtp L4952)', () => {
  const ok = { host: 'smtp.example.com', port: '587', sec: 'STARTTLS', from: 'Agent WBS <agent-wbs@example.com>', user: '', pw: '' };
  test('서버 · 포트 · 보내는 주소 · 계정만 있고 비밀번호 없음', () => {
    expect(smtpError(ok, false)).toBe('');
    expect(smtpError({ ...ok, host: '' }, false)).toBe('SMTP 서버를 입력하세요.');
    expect(smtpError({ ...ok, port: '70000' }, false)).toBe('포트는 1 ~ 65535 사이 숫자입니다.');
    expect(smtpError({ ...ok, from: 'Agent WBS <x>' }, false)).toContain('보내는 주소 형식');
    expect(smtpError({ ...ok, user: 'me' }, false)).toBe('계정을 입력했다면 비밀번호(앱 비밀번호)도 입력하세요.');
    // 저장된 비밀번호가 있으면 비워 두어도 된다
    expect(smtpError({ ...ok, user: 'me' }, true)).toBe('');
  });
});

describe('발송 상태 · 최근 발송 · 요약', () => {
  test('unknown은 「실패 — 수락 여부 불명」(data-model §3.7)', () => {
    expect(stateLabel('unknown').label).toBe('실패 — 수락 여부 불명');
    expect(stateLabel('accepted')).toEqual({ label: '발송됨', cls: 'vf v-pass' });
    expect(stateLabel('retry_wait').cls).toBe('vf v-fail');
  });
  test('최근 발송은 그 사람의 가장 최신 기록이다', () => {
    const log = [lg({ id: 'b', state: 'failed', reportKey: 'RPT-D-261104' }), lg({ id: 'a' })];
    expect(lastSend(log, 'qa@example.com')).toMatchObject({ label: '실패', reportKey: 'RPT-D-261104' });
    expect(lastSend(log, 'x')).toMatchObject({ label: '발송 기록 없음', at: null });
  });
  test('요약은 받는 중인 사람만 구독별로 센다', () => {
    expect(recipientSummary([rc('a@x.io', { weekly: true }), rc('b@x.io', { active: false, daily: false })])).toBe('수신자 2명 · 받는 중 1 (일간 1 · 주간 1)');
  });
});
