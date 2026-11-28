/**
 * M6-03 설정 → 보고서 · 메일 — 실제 API·전용 DB·로컬 가짜 SMTP(G§12 시나리오 25의 설정 화면 부분).
 * `pnpm --filter @awbs/web e2e:api:mail`이 환경을 만든다. 환경 변수가 없으면(일반 `W e2e`) 건너뛴다.
 *
 * 흐름: 빈 상태(SMTP 미설정 · 받는 사람 없음) → SMTP 설정 · 연결 확인 → 받는 사람 추가 오류(형식 · 구독 없음 · 중복) → qa@example.com 일간 추가
 * → 「테스트」 → 발송 기록 → 「미리보기」(HTML 메일) → SMTP 인증 실패 → 실패 배너 · 탭 배지 · 대시보드 알림 → 정상 복구 → 「실패 건 모두 다시 보내기」 → 알림 해제.
 * 끝으로 Q-13 결정 A: 외부 수신자를 추가해 「외부」 표시 · 고정 칸 · 링크 0건 · PDF 첨부 · 미리보기 안내를 확인한다.
 * 원본의 「Mock: SMTP 인증 실패 / 정상 복구」 버튼 대신 가짜 SMTP 서버의 응답 방식을 바꾼다(UAT-POLICY-05).
 */
import { expect, test, type Page } from '@playwright/test';
import { fillPin, todayPin } from './support/pin.ts';

const apiAvailable = !!process.env.AWBS_E2E_API;
const fake = process.env.AWBS_E2E_SMTP ? JSON.parse(process.env.AWBS_E2E_SMTP) as { smtpPort: number; controlPort: number; user: string; password: string } : null;
const shots = process.env.AWBS_E2E_SHOTS ?? '';
test.skip(!apiAvailable || !fake, '실제 API·가짜 SMTP 환경이 없다. pnpm --filter @awbs/web e2e:api:mail로 실행한다.');
test.describe.configure({ mode: 'serial' });

const serverErrors: string[] = [];
test.beforeEach(({ page }) => {
  page.on('response', (r) => { if (r.status() >= 500) serverErrors.push(`${r.request().method()} ${new URL(r.url()).pathname} ${String(r.status())}`); });
});
test.afterAll(() => { expect(serverErrors, '실제 API 5xx').toEqual([]); });

let cookies: Awaited<ReturnType<import('@playwright/test').BrowserContext['cookies']>> = [];
async function login(page: Page, path: string) {
  if (cookies.length) { await page.context().addCookies(cookies); await page.goto(path); return; }
  await page.goto(path);
  await expect(page).toHaveURL(/\/login/);
  await fillPin(page, todayPin());
  await page.getByRole('button', { name: '로그인' }).click();
  await expect(page).toHaveURL(path);
  cookies = await page.context().cookies();
}
const smtpMode = async (mode: string) => { await fetch(`http://127.0.0.1:${String(fake?.controlPort)}/mode/${mode}`, { method: 'POST' }); };
const received = async () => ((await (await fetch(`http://127.0.0.1:${String(fake?.controlPort)}/messages`)).json()) as { count: number }).count;
const tab = (page: Page) => page.getByRole('navigation', { name: '설정 영역' }).getByRole('link', { name: /보고서 · 메일/ });

test('빈 상태 → SMTP 설정 · 연결 확인 → 받는 사람 추가 오류 → qa@example.com 일간 추가', async ({ page }) => {
  await login(page, '/settings/report');
  await expect(page.getByText('등록된 받는 사람이 없습니다.')).toBeVisible();
  await expect(page.getByText('메일 서버가 설정되지 않았습니다.')).toBeVisible();
  await expect(page.getByText('발송 기록이 없습니다.')).toBeVisible();
  await expect(page.getByText('수신자 0명 · 받는 중 0 (일간 0 · 주간 0)')).toBeVisible();

  const smtp = page.getByRole('region', { name: '메일 서버 (SMTP)' });
  await smtp.getByRole('button', { name: 'SMTP 설정' }).click();
  await smtp.getByRole('button', { name: '저장' }).click();
  await expect(smtp.getByRole('alert')).toHaveText('SMTP 서버를 입력하세요.');
  await smtp.getByLabel('SMTP 서버').fill('127.0.0.1');
  await smtp.getByRole('button', { name: '암호화 없음 (사내 릴레이)' }).click();
  await expect(smtp.getByLabel('포트')).toHaveValue('25');
  await smtp.getByLabel('포트').fill(String(fake?.smtpPort));
  await smtp.getByLabel('보내는 주소').fill('Agent WBS <agent-wbs@example.com>');
  await smtp.getByLabel('계정').fill(fake?.user ?? '');
  await smtp.getByRole('button', { name: '저장' }).click();
  await expect(smtp.getByRole('alert')).toHaveText('계정을 입력했다면 비밀번호(앱 비밀번호)도 입력하세요.');
  await smtp.getByLabel('비밀번호').fill(fake?.password ?? '');
  await smtp.getByRole('button', { name: '저장' }).click();
  await expect(smtp.getByText('●●●●●●●● (저장됨 · 서버에 암호화 보관)')).toBeVisible();
  await expect(smtp.getByText('확인 전')).toBeVisible();
  await smtp.getByRole('button', { name: '연결 확인' }).click();
  await expect(smtp.locator('.vf', { hasText: '정상' })).toBeVisible();
  // 비밀번호는 화면 어디에도 다시 나오지 않는다
  expect(await page.content()).not.toContain(fake?.password ?? '#');

  const rc = page.getByRole('region', { name: '보고서 메일 — 받는 사람' });
  await rc.getByLabel('이메일 주소').fill('qa@');
  await rc.getByRole('button', { name: '받는 사람 추가' }).click();
  await expect(rc.getByRole('alert')).toHaveText('이메일 형식이 올바르지 않습니다 — 예: name@example.com');
  await rc.getByLabel('이메일 주소').fill('qa@example.com');
  await rc.getByRole('button', { name: '일간 (매일 07:00)' }).click();
  await rc.getByRole('button', { name: '주간 (월 07:00)' }).click();
  await rc.getByRole('button', { name: '받는 사람 추가' }).click();
  await expect(rc.getByRole('alert')).toHaveText('일간 · 주간 중 하나 이상 선택하세요.');
  await rc.getByRole('button', { name: '일간 (매일 07:00)' }).click();
  await rc.getByRole('button', { name: '받는 사람 추가' }).click();
  const row = rc.getByTestId('recipient-qa@example.com');
  await expect(row).toBeVisible();
  await expect(row.getByText('받는 중')).toBeVisible();
  await expect(rc.getByLabel('이메일 주소')).toHaveValue('');
  // 대소문자만 다른 주소는 중복
  await rc.getByLabel('이메일 주소').fill('QA@Example.com');
  await rc.getByRole('button', { name: '받는 사람 추가' }).click();
  await expect(rc.getByRole('alert')).toHaveText('이미 등록된 주소입니다.');
  await rc.getByLabel('이메일 주소').fill('');
});

test('「테스트」 → 발송 기록 → 「미리보기」로 HTML 메일 확인', async ({ page }) => {
  await login(page, '/settings/report');
  const before = await received();
  const row = page.getByTestId('recipient-qa@example.com');
  await row.getByRole('button', { name: '테스트' }).click();
  const log = page.getByRole('region', { name: '발송 기록' });
  await expect(log.locator('.gtr.lrow:not(.h)').first()).toContainText('발송됨', { timeout: 15_000 });
  await expect(log.locator('.gtr.lrow:not(.h)').first()).toContainText('테스트 발송');
  expect(await received()).toBe(before + 1);
  await expect(row.getByText('발송됨')).toBeVisible();
  // 원본 UI-12-04 스크린샷(1920×1080)과 나란히 보기 위한 증거. 데이터는 원본 Mock(받는 사람 3명)과 다르다.
  if (shots) { await page.setViewportSize({ width: 1920, height: 1080 }); await page.screenshot({ path: `${shots}/UI-12-04-impl.png`, fullPage: true }); }

  await row.getByRole('button', { name: '미리보기' }).click();
  const dialog = page.getByRole('dialog', { name: '메일 미리보기' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('agent-wbs@example.com')).toBeVisible();
  await expect(dialog.getByText('qa@example.com')).toBeVisible();
  await expect(dialog.getByText(/^\[Agent WBS\] (일간|주간|기간) 보고/)).toBeVisible();
  const frame = dialog.frameLocator('iframe[title="메일 본문 미리보기"]');
  await expect(frame.getByText('팀장 확인 필요')).toBeVisible();
  await expect(frame.locator('table[width="640"]')).toHaveCount(1);
  if (shots) await page.screenshot({ path: `${shots}/mail-preview-1440.png` });
  await dialog.getByRole('button', { name: '닫기' }).first().click();
  await expect(dialog).toBeHidden();
});

test('보고서 화면: 메일 미리보기 · 메일로 보내기 · 발송 기록 펼침(M6 통합, M6-03 README §9 · 원본 P L2127-2131)', async ({ page }) => {
  await login(page, '/report');
  const bar = page.locator('.rp-bar');
  await bar.getByRole('button', { name: '메일 미리보기' }).click();
  const pv = page.getByRole('dialog', { name: '메일 미리보기' });
  await expect(pv.getByText(/^\[Agent WBS\] (일간|주간|기간) 보고/)).toBeVisible();
  await expect(pv.frameLocator('iframe[title="메일 본문 미리보기"]').locator('table[width="640"]')).toHaveCount(1);
  await pv.getByRole('button', { name: '닫기' }).first().click();
  await expect(pv).toBeHidden();

  const sent = page.locator('details.rp-sent');
  await bar.getByRole('button', { name: '메일로 보내기' }).click();
  const dialog = page.getByRole('dialog', { name: '메일로 보내기' });
  const qa = dialog.getByRole('checkbox', { name: /qa@example\.com/ });
  await expect(qa).toBeVisible();
  // 기본 선택은 그 종류의 구독자다(qa는 일간 구독). 선택이 없으면 보내지 않고 안내한다(원본 doSend).
  if (!(await qa.isChecked())) {
    await dialog.getByRole('button', { name: '보내기', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText('받는 사람을 한 명 이상 선택하세요.');
    await qa.check();
  }
  await dialog.getByRole('button', { name: '보내기', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('메일 1건을 발송 대기열에 넣었습니다.')).toBeVisible();
  await expect(sent.locator('summary')).toHaveText(/메일 발송 \d+건/, { timeout: 15_000 });
  await sent.locator('summary').click();
  await expect(sent.locator('.gtr', { hasText: '수동 발송' }).first()).toContainText('qa@example.com');
  await expect(sent.locator('.gtr', { hasText: '수동 발송' }).first()).toContainText('발송됨', { timeout: 15_000 });
});

test('SMTP 인증 실패 → 실패 배너 · 탭 배지 · 대시보드 알림 → 정상 복구 → 「실패 건 모두 다시 보내기」 → 알림 해제', async ({ page }) => {
  await login(page, '/settings/report');
  await smtpMode('auth_fail');
  const smtp = page.getByRole('region', { name: '메일 서버 (SMTP)' });
  await smtp.getByRole('button', { name: '연결 확인' }).click();
  await expect(smtp.locator('.vf', { hasText: '실패' })).toBeVisible();
  await expect(smtp.getByText(/SMTP 인증 실패 — 535/)).toBeVisible();
  await expect(page.getByText('메일 서버 연결 실패')).toBeVisible();

  await page.getByTestId('recipient-qa@example.com').getByRole('button', { name: '테스트' }).click();
  const log = page.getByRole('region', { name: '발송 기록' });
  // 자동 재시도(보조 worker가 16분 뒤 시각으로도 판정해 곧바로 한 번 더) 뒤에도 실패하면 남는다
  await expect(log.getByText(/발송 실패 후 아직 성공하지 못한 메일 1건/)).toBeVisible({ timeout: 20_000 });
  await expect(log.locator('.gtr.lrow:not(.h)').first()).toContainText('자동 재시도');
  await expect(tab(page).getByLabel('문제 1건')).toBeVisible();
  await log.getByRole('button', { name: '실패만 1' }).click();
  await expect(log.locator('.gtr.lrow:not(.h)')).toHaveCount(1);
  if (shots) await page.screenshot({ path: `${shots}/mail-failed-1440.png`, fullPage: true });

  await page.goto('/');
  await expect(page.getByText(/보고서 메일 발송 실패 1건/)).toBeVisible();

  await page.goto('/settings/report');
  await smtpMode('accept');
  await smtp.getByRole('button', { name: '연결 확인' }).click();
  await expect(smtp.locator('.vf', { hasText: '정상' })).toBeVisible();
  await expect(page.getByText('메일 서버 연결 실패')).toBeHidden();
  await log.getByRole('button', { name: '실패 건 모두 다시 보내기' }).click();
  await expect(log.getByText(/발송 실패 후 아직 성공하지 못한 메일/)).toBeHidden({ timeout: 15_000 });
  await expect(tab(page).getByLabel(/문제 \d+건/)).toHaveCount(0);
  await log.getByRole('button', { name: /^전체/ }).click();
  await expect(log.locator('.gtr.lrow:not(.h)').first()).toContainText('다시 보내기');
  await page.goto('/');
  await expect(page.getByText(/보고서 메일 발송 실패/)).toHaveCount(0);
});

test('수신 설정: 일간 · 주간을 모두 끄면 자동으로 중지, 삭제해도 발송 기록은 남는다', async ({ page }) => {
  await login(page, '/settings/report');
  const row = page.getByTestId('recipient-qa@example.com');
  await row.getByRole('button', { name: '일간 보고 받기' }).click();
  await expect(row.getByText('중지', { exact: true })).toBeVisible();
  await expect(row).toHaveClass(/off/);
  await expect(row.getByRole('button', { name: '다시 받기' })).toBeDisabled();
  await row.getByRole('button', { name: '주간 보고 받기' }).click();
  await expect(row.getByText('받는 중')).toBeVisible();
  const logRows = page.getByRole('region', { name: '발송 기록' }).locator('.gtr.lrow:not(.h)');
  const count = await logRows.count();
  await row.getByRole('button', { name: '삭제' }).click();
  await expect(row).toBeHidden();
  await expect(logRows).toHaveCount(count);
});

test('[리뷰 지적 4] SMTP 수정 폼을 연 뒤 다른 탭이 먼저 저장하면 충돌 창이 뜨고 다른 탭의 값이 사라지지 않는다', async ({ page }) => {
  await login(page, '/settings/report');
  const other = await page.context().newPage();
  await other.goto('/settings/report');
  const smtpA = page.getByRole('region', { name: '메일 서버 (SMTP)' });
  const smtpB = other.getByRole('region', { name: '메일 서버 (SMTP)' });
  // A: 수정 폼을 연다(이 순간의 설정 버전을 기준으로 삼아야 한다).
  await smtpA.getByRole('button', { name: '수정' }).click();
  // B: 포트를 바꿔 먼저 저장한다. A는 변경 알림으로 최신 설정을 다시 읽는다.
  const refreshed = page.waitForResponse((r) => r.url().includes('/api/settings/mail/smtp') && r.request().method() === 'GET');
  await smtpB.getByRole('button', { name: '수정' }).click();
  await smtpB.getByLabel('포트').fill('2525');
  await smtpB.getByRole('button', { name: '저장' }).click();
  await expect(smtpB.getByText(/127\.0\.0\.1:2525/)).toBeVisible();
  await refreshed;
  // A: 열어 둔 폼으로 저장 → 낡은 편집이므로 덮어쓰지 않고 충돌 창
  await smtpA.getByLabel('포트').fill('2526');
  await smtpA.getByRole('button', { name: '저장' }).click();
  const conflict = page.getByRole('alertdialog', { name: '다른 변경이 먼저 저장되었습니다' });
  await expect(conflict).toBeVisible();
  await conflict.getByRole('button', { name: '최신 내용 불러오기 (내 변경 버림)' }).click();
  await expect(conflict).toBeHidden();
  await expect(smtpA.getByText(/127\.0\.0\.1:2525/)).toBeVisible();
  // 되돌림: 가짜 SMTP 포트로 다시 저장
  await smtpA.getByRole('button', { name: '수정' }).click();
  await smtpA.getByLabel('포트').fill(String(fake?.smtpPort));
  await smtpA.getByRole('button', { name: '저장' }).click();
  await expect(smtpA.getByText(new RegExp(`127\\.0\\.0\\.1:${String(fake?.smtpPort)}`))).toBeVisible();
  await other.close();
});

test('Q-13 결정 A: 외부 수신자 — 「외부」 표시 · 일간/보기/PDF 고정 · 메일 링크 0건 + PDF 첨부 · 미리보기 안내', async ({ page }) => {
  await login(page, '/settings/report');
  const rc = page.getByRole('region', { name: '보고서 메일 — 받는 사람' });
  await rc.getByLabel('이메일 주소').fill('partner@outside.example');
  await rc.getByRole('checkbox', { name: '외부 수신자' }).check();
  // 외부를 고르면 일간은 끄고 막으며, 보고용 · PDF로 고정한다.
  await expect(rc.getByRole('button', { name: '일간 (매일 07:00)' })).toBeDisabled();
  await expect(rc.getByRole('button', { name: '일간 (매일 07:00)' })).toHaveAttribute('aria-pressed', 'false');
  await rc.getByRole('button', { name: '받는 사람 추가' }).click();
  const row = rc.getByTestId('recipient-partner@outside.example');
  await expect(row).toBeVisible();
  await expect(row.getByRole('button', { name: '외부 수신자' })).toHaveAttribute('aria-pressed', 'true');
  await expect(row.getByRole('button', { name: '일간 보고 받기' })).toBeDisabled();
  await expect(row.getByRole('checkbox', { name: 'PDF 첨부' })).toBeChecked();
  await expect(row.getByRole('checkbox', { name: 'PDF 첨부' })).toBeDisabled();
  if (shots) await rc.screenshot({ path: `${shots}/mail-external-row.png` });

  const before = await received();
  await row.getByRole('button', { name: '테스트' }).click();
  const log = page.getByRole('region', { name: '발송 기록' });
  const first = log.locator('.gtr.lrow:not(.h)').first();
  await expect(first).toContainText('partner@outside.example');
  await expect(first).toContainText('발송됨', { timeout: 15_000 });
  await expect(first).toContainText('보고용 (요약) + PDF');
  await expect(first.locator('.tag', { hasText: '외부' })).toBeVisible();
  const messages = (await (await fetch(`http://127.0.0.1:${String(fake?.controlPort)}/messages`)).json()) as { count: number; items: { to: string[]; links: number; pdf: boolean }[] };
  expect(messages.count).toBe(before + 1);
  expect(messages.items.at(-1)).toEqual({ to: ['partner@outside.example'], links: 0, pdf: true });
  // 같은 환경의 내부 수신자 메일에는 링크가 있다(접속 주소가 설정돼 있음).
  expect(messages.items.some((m) => m.to[0] === 'qa@example.com' && m.links > 0)).toBe(true);

  await row.getByRole('button', { name: '미리보기' }).click();
  const dialog = page.getByRole('dialog', { name: '메일 미리보기' });
  await expect(dialog.getByText('외부 수신자', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/_보고용\.pdf/)).toBeVisible();
  const frame = dialog.frameLocator('iframe[title="메일 본문 미리보기"]');
  await expect(frame.getByText(/보고서 · 보고용/)).toBeVisible();
  await expect(frame.getByText('전체 보고서 보기')).toHaveCount(0);
  await expect(frame.locator('a')).toHaveCount(0);
  if (shots) await page.screenshot({ path: `${shots}/mail-external-1440.png` });
  await dialog.getByRole('button', { name: '닫기' }).first().click();

  // 「외부」를 끄면 내부 수신자로 돌아간다(다른 칸은 그대로).
  await row.getByRole('button', { name: '외부 수신자' }).click();
  await expect(row.getByRole('button', { name: '외부 수신자' })).toHaveAttribute('aria-pressed', 'false');
  await expect(row.getByRole('button', { name: '일간 보고 받기' })).toBeEnabled();
  await row.getByRole('button', { name: '삭제' }).click();
  await expect(row).toBeHidden();
});
