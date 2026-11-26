import type { InputDiff } from '../git/inputs.ts';
import type { AgentName, Analysis, CrossReview } from './agents.ts';
import type { AgreedEstimate, Disagreement } from './consensus.ts';

/*
 * 진행 기록에서 불러온 단계 결과의 형식 검사(checkpoint.output의 guard).
 * 손상된 값을 그대로 다음 단계에 넘기지 않으려는 것이다(독립 리뷰 4). 모양이 다르면 CHECKPOINT_UNREADABLE로 멈춘다.
 */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

export const isAnalysis = (v: unknown): v is Analysis => isRecord(v) && typeof v.summary === 'string' && strings(v.items);
export const isAnalysisPair = (v: unknown): v is Record<AgentName, Analysis> => isRecord(v) && isAnalysis(v.Codex) && isAnalysis(v.Claude);
export const isCross = (v: unknown): v is CrossReview =>
  isRecord(v) && typeof v.summary === 'string' && Array.isArray(v.reviews) && v.reviews.every(isRecord)
  && (v.tech === undefined || (isRecord(v.tech) && Array.isArray(v.tech.decisions) && Array.isArray(v.tech.conditionJudgements)));
export const isDiff = (v: unknown): v is InputDiff[] =>
  Array.isArray(v) && v.every((c) => isRecord(c) && typeof c.path === 'string' && typeof c.added === 'number' && typeof c.deleted === 'number');
export const isDisagreements = (v: unknown): v is { disagreements: Disagreement[] } =>
  isRecord(v) && Array.isArray(v.disagreements) && v.disagreements.every((d) => isRecord(d) && typeof d.target === 'string' && typeof d.rule === 'string');
export const isEstimates = (v: unknown): v is AgreedEstimate[] =>
  Array.isArray(v) && v.every((e) => isRecord(e) && typeof e.ref === 'string' && typeof e.estHours === 'number');
