/**
 * 설정 카드에서 함께 쓰는 작은 부품. 모양은 모두 원본 클래스(.seg·.frow·.dp-h·.banner)를 그대로 쓴다.
 */
import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { useApiQuery, apiKey, type ChangeTopic } from '../../shared/api/queries.ts';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import type { ApiError, CallArgs } from '../../shared/api/client.ts';
import type { OperationId, ResponseOf } from '../../shared/api/contract.ts';
import { useRefreshError } from '../../shared/layout/MenuScreen.tsx';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { codeLabel } from '../../shared/ui/errors.ts';
import { AreaLoading, useDelayedFlag } from '../../shared/ui/loading.tsx';

export interface SegOption<T> { value: T; label: string }

/** 원본 `.seg` 버튼 묶음(P L304–306). 누른 값은 aria-pressed로 알린다. */
export function Seg<T>({ label, options, value, onPick, disabled = false }: {
  label: string;
  options: readonly SegOption<NoInfer<T>>[];
  value: T | undefined;
  onPick: (value: NoInfer<T>) => void;
  disabled?: boolean;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={option.value === value}
          disabled={disabled}
          onClick={() => { if (option.value !== value) onPick(option.value); }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** 원본 `.frow`(왼쪽 이름 150px + 오른쪽 내용, P L334) */
export function Row({ label, children, style }: { label: ReactNode; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="frow" style={style}>
      <span className="flabel">{label}</span>
      <div className="fctl">{children}</div>
    </div>
  );
}

/** 카드 머리(원본 `.dp-h` + h3 자리의 h2, settings.css 1) */
export function CardHead({ id, title, children }: { id: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="dp-h">
      <h2 className="dp-t" id={id}>{title}</h2>
      {children}
    </div>
  );
}

/**
 * 카드가 직접 읽는 설정 값. 처음 읽기 전 0.2초가 지나면 영역 로딩, 처음부터 실패하면 카드 안 오류와 「다시 시도」.
 * 이미 보여 준 값의 갱신 실패는 카드를 바꾸지 않고 오류 막대로 알린다(편집 중 입력 보호, shared/README §2).
 */
export function useSettingQuery<Id extends OperationId>(id: Id, label: string, topics: readonly ChangeTopic[] = ['settings'], args?: Omit<CallArgs<Id>, 'signal'>) {
  const { client } = useApi();
  const callArgs = (args ?? {}) as Omit<CallArgs<Id>, 'signal'>;
  const query = useApiQuery(id, callArgs, { topics });
  useRefreshError(query, `${label} 최신 내용 불러오기`);
  return {
    query,
    queryKey: apiKey(id, callArgs),
    load: (signal?: AbortSignal) => client.call(id, { ...callArgs, ...(signal ? { signal } : {}) } as CallArgs<Id>),
  };
}

/** 데이터가 아직 없을 때 카드 본문 대신 보일 것(로딩·오류). 데이터가 있으면 null */
export function QueryGate({ query, label }: { query: UseQueryResult<unknown, ApiError>; label: string }) {
  const loading = useDelayedFlag(query.isPending && query.fetchStatus === 'fetching');
  if (query.data !== undefined) return null;
  if (query.isError) {
    const body = query.error.body?.error;
    return (
      <div className="banner danger set-err" role="alert">
        <div className="banner-b">
          <b>{label}을(를) 불러오지 못했습니다</b> ({codeLabel(query.error)}){body ? ` — ${body.message}` : ''}
        </div>
        <BusyButton small variant="default" busy={query.isFetching} busyLabel="다시 불러오는 중…" onClick={() => { void query.refetch(); }}>다시 시도</BusyButton>
      </div>
    );
  }
  return loading ? <AreaLoading label={`${label} 불러오는 중`} /> : null;
}

export type Data<Id extends OperationId> = ResponseOf<Id>;
