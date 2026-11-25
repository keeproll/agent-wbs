/** 오류 본문 (docs/plan/contracts.md §1.1). 오류 코드 목록은 M1-02에서 정의한다. */
export interface ErrorBody {
  error: {
    code: string;
    message: string;
    action: string;
    fix: string;
    errors: { path: string; rule: string; message: string }[];
    details: Record<string, unknown>;
    requestId: string;
  };
}

type ErrorInput = Pick<ErrorBody['error'], 'code' | 'message' | 'action' | 'fix' | 'requestId'> &
  Partial<Pick<ErrorBody['error'], 'errors' | 'details'>>;

export function errorBody(input: ErrorInput): ErrorBody {
  return { error: { errors: [], details: {}, ...input } };
}
