import type { Outbox } from '../api/outbox.ts';
import { DESIGN_SNAPSHOT_SCHEMA, type ClaimedJob } from '../api/generated/client.ts';
import { parseContracts, type ContractFile } from './parse.ts';
import { DESIGN_LIMITS, compareShapes, validShape, type DesignItem, type DesignShape, type DesignSnapshot } from './shape.ts';

export interface SnapshotInput { commit: string; jobId: string; fence: number; ref: string; jobKind: ClaimedJob['kind']; branch?: string; files: readonly ContractFile[] }
export type DesignExtractor = (context: { commit: string; ref: string; item: DesignItem; signal: AbortSignal }) => Promise<unknown>;
export type DesignExtractors = Partial<Record<'openapi' | 'asyncapi' | 'sql', DesignExtractor>>;
const REF = new RegExp(DESIGN_SNAPSHOT_SCHEMA.properties.ref.pattern);

/** 실제 추출은 자격 증명을 격리한 호출자가 제공한다. 미설치·실패·미지원은 모두 대조 안 함이다. */
export async function buildDesignSnapshot(input: SnapshotInput, extractors: DesignExtractors = {}): Promise<DesignSnapshot> {
  const { commit, jobId, fence, ref } = input;
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(commit) || !jobId.trim() || jobId.length > 128 ||
    !Number.isInteger(fence) || fence < 0 || fence > 2147483647 || typeof ref !== 'string' || !REF.test(ref)) throw new Error('설계 보고의 commit·jobId·fence·ref가 올바르지 않습니다.');
  if (ref === 'main' ? !['design_apply', 'merge_followup'].includes(input.jobKind) : input.jobKind !== 'attempt' || ref !== input.branch) throw new Error('job 종류·Task와 설계 보고 브랜치가 다릅니다.');
  const { files, items, problems } = parseContracts(input.files, ref);
  const drifts: DesignSnapshot['drifts'] = [];
  const deadline = performance.now() + DESIGN_LIMITS.totalMs;
  let extractedBytes = 0;
  for (const item of items) {
    const format = files.find(f => f.path === item.path)?.format;
    const extractor = format === 'OpenAPI 3.1' ? extractors.openapi : format === 'AsyncAPI 3.0' ? extractors.asyncapi : format === 'SQL' ? extractors.sql : undefined;
    let extracted: DesignShape | null = null;
    if (extractor && item.contract && performance.now() < deadline) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, Math.min(DESIGN_LIMITS.extractMs, Math.max(0, deadline - performance.now()))); });
        const value = await Promise.race([Promise.resolve().then(() => extractor({ commit, ref, item: structuredClone(item), signal: controller.signal })), timeout]);
        if (validShape(value)) {
          const bytes = Buffer.byteLength(JSON.stringify(value));
          if (extractedBytes + bytes <= DESIGN_LIMITS.reportBytes / 4) {
            extractedBytes += bytes;
            extracted = { fields: value.fields.map(({ path, type, required }) => ({ path, type, required })) };
          }
        }
      } catch { /* 추출 실패는 일치가 아니다. 아래에서 unchecked를 남긴다. */ }
      finally { clearTimeout(timer); }
    }
    item.extracted = extracted;
    const difference = compareShapes(item.contract, extracted, item.kind);
    const problem = problems[item.itemKey];
    if (difference && problem) difference.text = problem;
    if (difference) drifts.push({ itemKey: item.itemKey, kind: item.kind, ...difference, ...(item.taskKey && { taskKey: item.taskKey }) });
  }
  const result = { commit, jobId, fence, ref, files, items, drifts };
  if (Buffer.byteLength(JSON.stringify(result)) > DESIGN_LIMITS.reportBytes) throw new Error('설계 보고 크기 상한을 넘었습니다.');
  return result;
}

/** 전송 전에 기존 Outbox(영속 보고 대기함)에 저장한다. 재시도와 서버 응답 처리는 Outbox가 맡는다. */
export async function reportDesignSnapshot(outbox: Outbox, input: SnapshotInput & { epoch: number }, extractors: DesignExtractors = {}) {
  const body = await buildDesignSnapshot(input, extractors);
  return outbox.enqueue('reportDesignSnapshot', { epoch: input.epoch, body });
}
