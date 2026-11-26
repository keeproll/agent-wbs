import type { Db } from './db.ts';
import { changeEvent, iso } from './db.ts';

/** 비밀 열은 조회하지 않는다. 연결 여부는 Runner의 실제 보고만으로 정한다(contracts §2.2·§3.1). */
export async function githubSettings(db: Db) {
  const row = (await db.query<{ mode: 'gh' | 'token'; tokenSet: boolean; status: string; account: string | null;
    scopes: unknown; warning: string | null; expiresAt: string | null; updatedAt: string | null }>(
    `select mode,secret_key is not null "tokenSet",status,account,scopes,warning,${iso('expires_at')} "expiresAt",${iso('updated_at')} "updatedAt"
     from github_settings where singleton`)).rows[0];
  return row ?? { mode: 'gh', tokenSet: false, status: 'unchecked', account: null, scopes: null, warning: null, expiresAt: null, updatedAt: null };
}

export interface GithubReport { mode: 'gh' | 'token'; ok: boolean; account: string | null; scopes: unknown; expiresAt: string | null; warning?: string }

export async function reportGithubStatus(db: Db, body: GithubReport) {
  await db.query(`insert into github_settings(singleton,mode,status,account,scopes,warning,expires_at) values(true,$1,$2,$3,$4::jsonb,$5,$6)
    on conflict (singleton) do update set mode=excluded.mode,status=excluded.status,account=excluded.account,scopes=excluded.scopes,warning=excluded.warning,expires_at=excluded.expires_at`,
  [body.mode, body.ok ? 'ok' : 'failed', body.account, body.scopes === null ? null : JSON.stringify(body.scopes), body.warning ?? null, body.expiresAt]);
  await changeEvent(db, null, { kind: 'github' }, 'settings');
}
