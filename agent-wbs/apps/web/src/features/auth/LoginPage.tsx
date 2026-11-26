/**
 * 로그인 화면(UI-AUTH) — owner Q-01로 추가한 화면 1개. 원본에는 없어서 원본의 시각 언어(카드·버튼·배너)로 만든다.
 *
 * - LAN(같은 사무실 네트워크) 접속: 비밀번호 입력.
 * - 이 PC(서버를 실행한 PC) 접속: 1회용 링크. 이 화면은 새 링크 발급 방법을 안내한다.
 *   링크를 열면 ApiProvider가 토큰을 주소에서 지우고 로그인한다.
 * - 실패는 구분 없이 LOGIN_FAILED로 온다(contracts §2.4). 그래서 화면도 원인을 짐작해 말하지 않는다.
 * - 429(횟수 제한)는 Retry-After 초만큼 버튼을 막는다(UAT-AUTH-03).
 */
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import { ApiError } from '../../shared/api/client.ts';
import { safeReturnPath } from '../../shared/auth/login-link.ts';
import { useDocumentTitle } from '../../shared/layout/Page.tsx';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { codeLabel } from '../../shared/ui/errors.ts';
import { ICON, Icon } from '../../shared/ui/Icon.tsx';
import { LOGIN_LINK_COMMAND } from './login-command.ts';
import { markLoggedIn } from '../../shared/state/sessionDrafts.ts';


interface Problem { kind: 'failed' | 'link' | 'limited' | 'other'; error?: ApiError }

function problemText(problem: Problem, wait: number): string {
  switch (problem.kind) {
    case 'link': return '1회용 링크로 로그인하지 못했습니다. 링크는 한 번만 쓸 수 있고 발급 5분 뒤 만료되며, 서버를 실행한 이 PC에서만 쓸 수 있습니다. 아래 안내대로 새 링크를 발급하세요.';
    case 'failed': return '로그인하지 못했습니다. 비밀번호를 확인한 뒤 다시 입력하세요.';
    case 'limited': return wait > 0 ? `로그인 시도가 너무 많습니다. ${String(wait)}초 뒤에 다시 시도하세요.` : '이제 다시 시도할 수 있습니다.';
    default: return '서버가 로그인 요청을 처리하지 못했습니다. 서버가 실행 중인지 확인한 뒤 다시 시도하세요.';
  }
}

export function LoginPage() {
  useDocumentTitle('로그인');
  const { client, session, refreshSession } = useApi();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeReturnPath(params.get('next'));
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(() => (params.get('link') === 'failed' ? { kind: 'link' } : null));
  const [waitUntil, setWaitUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const wait = Math.max(0, Math.ceil((waitUntil - now) / 1000));
  const inputId = useId();
  const errorId = useId();

  useEffect(() => {
    if (waitUntil <= Date.now()) return;
    const timer = setInterval(() => { setNow(Date.now()); }, 250);
    return () => { clearInterval(timer); };
  }, [waitUntil]);

  if (session) return <Navigate to={next} replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || wait > 0 || password === '') return;
    setBusy(true);
    try {
      await client.call('login', { body: { method: 'password', password } });
      markLoggedIn();
      setPassword('');
      await refreshSession();
      void navigate(next, { replace: true });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.kind === 'rateLimited') {
        const until = Date.now() + (error.retryAfterSec ?? 60) * 1000;
        setWaitUntil(until);
        setNow(Date.now());
        setProblem({ kind: 'limited', error });
      } else if (error.code === 'LOGIN_FAILED') {
        setProblem({ kind: 'failed', error });
      } else {
        setProblem({ kind: 'other', error });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <main className="login-box" aria-labelledby="login-t">
        <div className="brand"><span className="logo" aria-hidden="true">AW</span><span>Agent WBS</span></div>
        <h1 id="login-t">로그인</h1>
        <p className="page-sub">팀장만 사용할 수 있습니다. 같은 사무실 네트워크(LAN)에서는 비밀번호로, 서버를 실행한 이 PC에서는 1회용 링크로 로그인합니다.</p>

        {problem && (
          <div className="banner danger" role="alert" id={errorId}>
            <Icon d={ICON.warning} />
            <div className="banner-b">
              {problemText(problem, wait)}
              {problem.error && <> <span className="mono">({codeLabel(problem.error)})</span></>}
            </div>
          </div>
        )}

        <form className="card login-card" onSubmit={(event) => { void submit(event); }} noValidate>
          <h2 className="login-h">LAN 비밀번호로 로그인</h2>
          <label className="fsel-l" htmlFor={inputId}>비밀번호</label>
          <input
            id={inputId}
            className="inp"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            aria-invalid={problem?.kind === 'failed' || undefined}
            aria-describedby={problem ? errorId : undefined}
            onChange={(event) => { setPassword(event.target.value); }}
          />
          <div className="form-acts">
            <BusyButton type="submit" busy={busy} busyLabel="로그인 중…" disabled={password === '' || wait > 0}>
              {wait > 0 ? `${String(wait)}초 뒤 다시 시도` : '로그인'}
            </BusyButton>
          </div>
        </form>

        <section className="card login-card" aria-labelledby="login-link-t">
          <h2 className="login-h" id="login-link-t">이 PC에서 로그인(1회용 링크)</h2>
          <p>서버를 실행한 PC에서는 비밀번호 대신 1회용 링크를 씁니다. 그 PC의 터미널에서 저장소 폴더로 가서 아래 명령으로 새 링크를 발급한 뒤, 출력된 주소를 브라우저에서 여세요.</p>
          <pre className="login-cmd"><code>{LOGIN_LINK_COMMAND}</code></pre>
          <p className="fhint">링크는 한 번만 쓸 수 있고 발급 5분 뒤 만료됩니다. 링크를 열면 주소에서 토큰이 바로 지워집니다. 비밀번호를 잊었다면 이 PC에서 auth CLI의 set-password로 다시 설정합니다.</p>
        </section>
      </main>
    </div>
  );
}
