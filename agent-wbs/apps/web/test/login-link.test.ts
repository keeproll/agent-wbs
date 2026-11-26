import { describe, expect, it } from 'vitest';
import { readLoginToken, safeReturnPath } from '../src/shared/auth/login-link.ts';

describe('1회용 링크 토큰 읽기(contracts §2.4, auth CLI login-link)', () => {
  it('#login-token= fragment에서 토큰을 꺼내고 남길 hash를 돌려준다', () => {
    expect(readLoginToken('#login-token=abc_DEF-123')).toEqual({ token: 'abc_DEF-123', rest: '' });
    expect(readLoginToken('#x=1&login-token=t1')).toEqual({ token: 't1', rest: '#x=1' });
  });
  it('토큰이 없거나 비면 null', () => {
    expect(readLoginToken('')).toBeNull();
    expect(readLoginToken('#login-token=')).toBeNull();
    expect(readLoginToken('#other=1')).toBeNull();
  });
});

describe('로그인 뒤 돌아갈 주소', () => {
  it('같은 앱 안의 경로만 허용한다', () => {
    expect(safeReturnPath('/wbs/TASK-0007?tab=spec')).toBe('/wbs/TASK-0007?tab=spec');
    expect(safeReturnPath('//evil.example/x')).toBe('/dashboard');
    expect(safeReturnPath('https://evil.example')).toBe('/dashboard');
    expect(safeReturnPath('/login')).toBe('/dashboard');
    expect(safeReturnPath(null)).toBe('/dashboard');
  });
});
