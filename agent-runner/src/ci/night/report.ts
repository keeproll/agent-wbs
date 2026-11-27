import { randomUUID } from 'node:crypto';
import type { ApiClient, ApiRequest } from '../../api/client.ts';
import type { Outbox } from '../../api/outbox.ts';

export type CiStartBody = ApiRequest<'startCiRun'>['body'];
export type CiUpdateBody = ApiRequest<'updateCiRun'>['body'];

/** ③④가 서버에 실행을 보고하는 통로다. M7-06이 실제 ApiClient·outbox로 연결한다. */
export interface CiReport {
  /** 시작 응답의 실행 ID가 있어야 근거 폴더를 만들 수 있어 바로 호출한다. 같은 키로 다시 부르면 서버가 같은 실행을 돌려준다.
   * 키를 생략하면(배포 확인) 일반 형식 `startCiRun:<runnerId>:<uuid>`를 만든다. */
  start(body: CiStartBody, idempotencyKey?: string): Promise<{ id: string; runKey: string }>;
  /** 진행·결과 보고. 순서가 바뀌면 안 되므로 outbox의 한 흐름에 넣는다. */
  update(id: string, body: CiUpdateBody): Promise<void>;
}

export interface ApiCiReportOptions { api: ApiClient; outbox: Pick<Outbox, 'enqueue' | 'flush'>; epoch: () => number; runnerId: () => string }

/** 기존 client(시작)와 outbox(갱신)를 재사용한다. 갱신은 저장 뒤 보내므로 Runner가 죽어도 다시 보낸다. */
export function apiCiReport({ api, outbox, epoch, runnerId }: ApiCiReportOptions): CiReport {
  return {
    async start(body, idempotencyKey) {
      const response = await api('startCiRun', { body, epoch: epoch(), idempotencyKey: idempotencyKey ?? `startCiRun:${runnerId()}:${randomUUID()}` });
      return response.body;
    },
    async update(id, body) {
      await outbox.enqueue('updateCiRun', { params: { id }, body, epoch: epoch(), idempotencyKey: `updateCiRun:${runnerId()}:${randomUUID()}` });
      await outbox.flush();
    },
  };
}
