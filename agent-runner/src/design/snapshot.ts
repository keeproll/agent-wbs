import type { Outbox } from '../api/outbox.ts';
import { parseContracts, type ContractFile } from './parse.ts';
import { compareShapes, validShape, type DesignItem, type DesignShape, type DesignSnapshot } from './shape.ts';

export interface SnapshotInput { commit: string; jobId: string; fence: number; ref?: string; files: readonly ContractFile[] }
export type DesignExtractor = (context: { commit: string; ref: string; item: DesignItem }) => Promise<unknown>;
export type DesignExtractors = Partial<Record<'openapi' | 'asyncapi' | 'sql', DesignExtractor>>;

/** 실제 추출은 자격 증명을 격리한 호출자가 제공한다. 미설치·실패·미지원은 모두 대조 안 함이다. */
export async function buildDesignSnapshot(input: SnapshotInput, extractors: DesignExtractors = {}): Promise<DesignSnapshot> {
  const { commit, jobId, fence, ref = 'main' } = input;
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(commit) || !jobId.trim() || jobId.length > 128 ||
    !Number.isInteger(fence) || fence < 0 || fence > 2147483647 || !ref.trim() || [...ref].some(c => c.charCodeAt(0) < 32)) throw new Error('설계 보고의 commit·jobId·fence·ref가 올바르지 않습니다.');
  const { files, items } = parseContracts(input.files, ref);
  const drifts: DesignSnapshot['drifts'] = [];
  for (const item of items) {
    const format = files.find(f => f.path === item.path)?.format;
    const extractor = format === 'OpenAPI 3.1' ? extractors.openapi : format === 'AsyncAPI 3.0' ? extractors.asyncapi : format === 'SQL' ? extractors.sql : undefined;
    let extracted: DesignShape | null = null;
    if (extractor && item.contract) {
      try {
        const value = await extractor({ commit, ref, item: structuredClone(item) });
        if (validShape(value)) extracted = { fields: value.fields.map(({ path, type, required }) => ({ path, type, required })) };
      } catch { /* 추출 실패는 일치가 아니다. 아래에서 unchecked를 남긴다. */ }
    }
    item.extracted = extracted;
    const difference = compareShapes(item.contract, extracted);
    if (difference) drifts.push({ itemKey: item.itemKey, kind: item.kind, ...difference, ...(item.taskKey && { taskKey: item.taskKey }) });
  }
  return { commit, jobId, fence, ref, files, items, drifts };
}

/** 전송 전에 기존 Outbox(영속 보고 대기함)에 저장한다. 재시도와 서버 응답 처리는 Outbox가 맡는다. */
export async function reportDesignSnapshot(outbox: Outbox, input: SnapshotInput & { epoch: number }, extractors: DesignExtractors = {}) {
  const body = await buildDesignSnapshot(input, extractors);
  return outbox.enqueue('reportDesignSnapshot', { epoch: input.epoch, body });
}
