import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../state/files.ts';

/*
 * Planning 작업의 로컬 진행 기록(checkpoint, 다시 이어 하기 위한 저장점).
 *
 * 왜 필요한가:
 * - 단계가 실패하면 서버는 같은 Planning 작업에 새 Runner job을 만들고 「실패한 단계부터」(resumeStep) 하라고 한다.
 *   그런데 Runner가 서버에서 이전 분석 결과를 읽는 API는 없다(contracts §3.2: Runner는 payload만으로 판단한다).
 *   그래서 끝난 단계의 결과(Codex·Claude 분석, 교차 검토, diff)를 이 PC에 저장해 두고 다음 job에서 다시 쓴다.
 * - 보낸 요청과 멱등 키도 저장한다. 응답을 잃거나 Runner가 재시작해 같은 job을 다시 실행하면,
 *   같은 키·같은 본문으로 다시 보내 서버가 한 번만 처리하게 한다(contracts §1.2 멱등).
 *
 * 저장 위치: `AWBS_HOME/state/planning/e<초기화 번호>-<작업 키의 SHA-256 앞 32자>.json`.
 * 초기화 정리는 이 폴더를 통째로 지운다(원본 §4.2 ③ 「기록·결과를 남기지 않음」). 쓰기는 임시 파일·fsync·이름 교체(atomicWrite)다.
 * 결과(outputs)는 분석 회차(runNo)별로 둔다. 재분석은 회차가 바뀌므로 이전 회차 결과를 쓰지 않는다.
 */

export interface SentRequest { key: string; request: unknown }
interface Document {
  version: 1;
  /** 초기화 번호(epoch). 다른 번호의 기록은 쓰지 않는다. */
  epoch: number;
  /** 회차 → 단계 결과 이름 → 값 */
  outputs: Record<string, Record<string, unknown>>;
  /** `<Runner job ID>:<요청 이름>` → 보낸 요청 */
  sent: Record<string, SentRequest>;
}

const empty = (epoch: number): Document => ({ version: 1, epoch, outputs: {}, sent: {} });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** 보고기(reporter.ts)가 만드는 멱등 키 형식 `<operation>:<runnerId>:<uuid>` */
const KEY = /^[A-Za-z]+:[^:\s]+:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

/** Planning이 보내는 보고와 그 경로 인자. 모두 본문(fence 포함)이 필요하다. */
const PLANNING_REPORTS: Record<string, readonly string[]> = {
  reportBootstrapProgress: ['jobId'], submitDraft: ['jobId'], submitTechProposals: ['jobId'],
  submitPlanningAnalysis: ['id'], submitPlanningReviews: ['id'], submitProposalJudgements: ['id'],
  submitTaskPlan: ['taskKey'], submitPlanningProposal: [], submitEstimates: [],
};

/**
 * 보낸 요청 하나의 검사. 문제가 없으면 null, 있으면 이유.
 * 기록할 때(recordSent)와 읽을 때(load) 이 함수 하나를 같이 쓴다(재리뷰 3).
 * 왜: 본문이 빠진 요청을 그대로 다시 보내면 손상된 로컬 기록이 서버 오류처럼 보이고, 재시도해도 같은 요청만 반복한다.
 */
export function sentProblem(entry: unknown): string | null {
  if (!isRecord(entry) || typeof entry.key !== 'string' || !KEY.test(entry.key)) return '멱등 키 형식이 다릅니다';
  const operation = entry.key.split(':')[0] ?? '';
  const params = PLANNING_REPORTS[operation];
  if (!params) return `Planning이 보내지 않는 보고입니다: ${operation}`;
  if (!isRecord(entry.request)) return '요청이 객체가 아닙니다';
  const { params: given, body } = entry.request;
  if (!isRecord(body) || typeof body.fence !== 'number') return '본문(fence 포함)이 없습니다';
  if (params.length && !(isRecord(given) && params.every((name) => typeof given[name] === 'string' && given[name] !== ''))) return `경로 인자(${params.join(',')})가 없습니다`;
  if (given !== undefined && !isRecord(given)) return '경로 인자가 객체가 아닙니다';
  return null;
}

/**
 * 형식이 조금이라도 다르면 받지 않는다. 문법만 맞는 손상(예: `outputs: []`)도 거부한다.
 * 왜: 손상된 기록을 빈 기록처럼 쓰면 이미 보낸 요청의 멱등 키를 잃고 새 키로 다시 보내, 초안·CP를 두 번 처리하게 된다(독립 리뷰 4).
 */
function validate(value: unknown, epoch: number): Document | string {
  if (!isRecord(value) || value.version !== 1) return '버전이 다릅니다';
  if (value.epoch !== epoch) return `초기화 번호가 다릅니다(기록 ${String(value.epoch)}, 현재 ${String(epoch)})`;
  if (!isRecord(value.outputs) || !Object.values(value.outputs).every(isRecord)) return '단계 결과 형식이 다릅니다';
  if (!isRecord(value.sent) || !Object.values(value.sent).every((e) => sentProblem(e) === null)) return '보낸 요청 형식이 다릅니다';
  return value as unknown as Document;
}

export class PlanningCheckpointError extends Error { override name = 'PlanningCheckpointError'; }
/** 저장하려는 단계 결과의 형식이 틀렸다(Agent 출력 문제). 디스크에 쓰지 않는다. */
export class PlanningOutputInvalid extends Error { override name = 'PlanningOutputInvalid'; }

/** 단계 결과의 형식 검사. 저장할 때와 불러올 때 같은 함수를 쓴다. `problem`이 있으면 이유를 설명한다. */
export type Guard<T> = ((value: unknown) => value is T) & { problem?: (value: unknown) => string | null };

export class PlanningCheckpoint {
  readonly epoch: number;
  private readonly directory: string;
  private readonly file: string;
  private doc: Document;
  private readonly runNo: number;
  private constructor(directory: string, file: string, doc: Document, runNo: number) {
    this.directory = directory;
    this.file = file;
    this.doc = doc;
    this.runNo = runNo;
    this.epoch = doc.epoch;
  }

  /** 파일 이름에 초기화 번호를 넣는다. 새 번호에서는 옛 번호의 파일을 아예 열지 않는다. */
  static fileName(epoch: number, workKey: string): string {
    return `e${String(epoch)}-${createHash('sha256').update(workKey).digest('hex').slice(0, 32)}.json`;
  }

  static async load(directory: string, epoch: number, workKey: string, runNo: number): Promise<PlanningCheckpoint> {
    const file = PlanningCheckpoint.fileName(epoch, workKey);
    let text: string;
    try { text = await readFile(join(directory, file), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new PlanningCheckpoint(directory, file, empty(epoch), runNo);
      throw new PlanningCheckpointError(`Planning 진행 기록 ${file}을 읽지 못했습니다.`);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { throw new PlanningCheckpointError(`Planning 진행 기록 ${file}의 JSON 문법이 깨졌습니다.`); }
    // 깨진 기록을 고쳐 쓰지 않는다. 지우면 이미 보낸 요청의 멱등 키를 잃어 중복 처리될 수 있다.
    const doc = validate(parsed, epoch);
    if (typeof doc === 'string') throw new PlanningCheckpointError(`Planning 진행 기록 ${file}이 손상되었습니다: ${doc}.`);
    return new PlanningCheckpoint(directory, file, doc, runNo);
  }

  /** 저장된 단계 결과. 없으면 undefined, 있는데 모양이 다르면 손상으로 보고 멈춘다. */
  output<T>(name: string, guard: Guard<T>): T | undefined {
    const value = this.doc.outputs[String(this.runNo)]?.[name];
    if (value === undefined) return undefined;
    if (!guard(value)) throw new PlanningCheckpointError(`Planning 진행 기록 ${this.file}의 「${name}」 결과가 손상되었습니다.`);
    return value;
  }

  /** 불러올 때와 같은 guard로 먼저 검사한다. 틀린 값은 디스크에 쓰지 않는다. */
  async saveOutput<T>(name: string, value: T, guard: Guard<T>): Promise<void> {
    if (!guard(value)) throw new PlanningOutputInvalid(`「${name}」 결과의 형식이 틀려 저장하지 않습니다: ${guard.problem?.(value) ?? '모양이 다릅니다'}`);
    const run = String(this.runNo);
    await this.write({ ...this.doc, outputs: { ...this.doc.outputs, [run]: { ...this.doc.outputs[run], [name]: structuredClone(value) } } });
  }

  sent(jobId: string, name: string): SentRequest | undefined {
    return this.doc.sent[`${jobId}:${name}`];
  }

  async recordSent(jobId: string, name: string, entry: SentRequest): Promise<void> {
    const problem = sentProblem(entry);
    if (problem) throw new PlanningCheckpointError(`보낼 요청 「${name}」이 올바르지 않아 기록하지 않습니다: ${problem}`);
    await this.write({ ...this.doc, sent: { ...this.doc.sent, [`${jobId}:${name}`]: structuredClone(entry) } });
  }

  private async write(next: Document): Promise<void> {
    // 디스크에 먼저 쓰고 메모리를 바꾼다. 쓰다 실패하면 메모리도 그대로다.
    await atomicWrite(this.directory, this.file, JSON.stringify(next));
    this.doc = next;
  }
}

/** `AWBS_HOME/state/planning` — 초기화 정리(cleanup/reset.ts)가 통째로 지우는 폴더 */
export function planningStateDirectory(home: string): string {
  return join(home, 'state', 'planning');
}

export class PlanningCheckpoints {
  private readonly directory: string;
  private constructor(directory: string) { this.directory = directory; }

  /** `home`은 AWBS_HOME이다. 폴더는 Runner 사용자만 읽고 쓴다(0700). */
  static async open(home: string): Promise<PlanningCheckpoints> {
    const directory = planningStateDirectory(home);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return new PlanningCheckpoints(directory);
  }

  async load(epoch: number, workKey: string, runNo: number): Promise<PlanningCheckpoint> {
    // 초기화 정리가 폴더를 지운 뒤에도 같은 객체로 이어 쓸 수 있게 다시 만든다.
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    return PlanningCheckpoint.load(this.directory, epoch, workKey, runNo);
  }
}
