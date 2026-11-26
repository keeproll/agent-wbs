/** 변경 제안 화면이 쓰는 계약 타입 별칭. 모두 계약(@awbs/shared/api)에서 뽑은 타입이다. */
import type { ResponseOf } from '../../shared/api/contract.ts';

export type Proposal = ResponseOf<'listProposals'>['items'][number];
export type ProposalOp = Proposal['ops'][number];
export type ProposalPreview = ResponseOf<'previewProposal'>;
export type DiffEntry = ProposalPreview['diff'][number];
export type Impact = ProposalPreview['impact'];
export type HoldReason = Proposal['holdReasons'][number];
export type ProposalIssue = Proposal['issues'][number];
