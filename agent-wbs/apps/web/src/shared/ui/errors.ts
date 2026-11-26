/**
 * 오류를 화면 문구로 바꾸는 규칙(G§0.3 「오류 처리 규칙」, contracts §1.1).
 * 문구에는 무엇을 하려다(대상 동작)·왜 실패했고(코드·원인)·무엇을 하면 되는지(조치)를 함께 쓴다.
 */
import type { ApiError } from '../api/client.ts';

/** 오류 코드 칸에 보일 글자. 예: `500 INTERNAL`, `NETWORK_ERROR`, `응답 없음 · 10초 초과` */
export function codeLabel(error: ApiError): string {
  if (error.kind === 'timeout') return '응답 없음 · 10초 초과';
  if (error.status === null) return error.code;
  return `${String(error.status)} ${error.code}`;
}

/** 같은 요청을 그대로 다시 보내도 되는 오류인가. 400(입력 수정 필요)·409(최신 상태 확인 필요)는 아니다. */
export const canRetry = (error: ApiError): boolean =>
  error.kind === 'server' || error.kind === 'network' || error.kind === 'timeout' || error.kind === 'unavailable';

/** 오류 막대 제목의 뒷부분(원본 errFlags P L6846–6851 문구를 따른다) */
export function causeTitle(error: ApiError): string {
  switch (error.kind) {
    case 'validation': return '서버 검증 실패';
    case 'network':
    case 'timeout': return '서버에 연결할 수 없음';
    case 'unavailable': return '서버를 잠시 쓸 수 없음';
    case 'rateLimited': return '요청이 너무 많음';
    case 'rejected': return '지금 상태에서는 할 수 없음';
    case 'notFound': return '대상을 찾을 수 없음';
    case 'forbidden': return '권한 없음';
    case 'conflict': return '다른 변경이 먼저 저장됨';
    case 'unauthorized': return '로그인이 필요함';
    default: return '서버 오류';
  }
}

/** 원인과 조치 문장. 서버가 보낸 message·fix를 우선 쓴다. */
export function causeMessage(error: ApiError, keepsInput = true): string {
  const kept = keepsInput ? ' 입력한 내용은 화면에 그대로 남아 있습니다.' : '';
  if (error.kind === 'network') return `Agent WBS 서버에 연결할 수 없습니다(응답 없음).${kept} 연결이 복구되면 다시 시도하세요.`;
  if (error.kind === 'timeout') return `Agent WBS 서버가 10초 안에 응답하지 않았습니다.${kept} 서버가 실행 중인지 확인한 뒤 다시 시도하세요.`;
  const body = error.body?.error;
  if (body) return [body.message, kept.trim(), body.fix].filter(Boolean).join(' ');
  if (error.kind === 'validation') return `서버가 입력값을 받아들이지 않았습니다.${kept} 표시된 항목을 고친 뒤 다시 저장하세요.`;
  return `서버에서 요청을 처리하지 못했습니다.${kept} 잠시 후 다시 시도하세요. 계속 실패하면 서버 로그를 확인해야 합니다.`;
}
