/**
 * 계약 타입 — @awbs/shared/api의 TypeBox 정의에서 뽑아낸 타입만 쓴다.
 * 화면 코드에서 요청·응답 모양을 손으로 다시 적지 않는다.
 * 왜: 서버 계약(openapi.json의 원본)과 화면이 어긋나면 typecheck에서 바로 드러나게 하려고.
 */
import type {
  ErrorCode,
  ErrorResponse,
  planningOperations,
  projectOperations,
  settingsOperations,
  systemOperations,
  wbsOperations,
} from '@awbs/shared/api';
import type { Static, TSchema } from 'typebox';

type AnyOp =
  | (typeof wbsOperations)[number]
  | (typeof projectOperations)[number]
  | (typeof settingsOperations)[number]
  | (typeof systemOperations)[number]
  | (typeof planningOperations)[number];

/** 화면(팀장)이 부를 수 있는 JSON 요청. Runner 전용 요청과 파일(바이너리) 응답 요청은 빠진다. */
type ScreenOp = Exclude<AnyOp, { principal: 'runner' } | { binary: string }>;
export type OperationId = ScreenOp['id'];
/** 파일을 내려받는 요청(PDF·ZIP·Evidence 원본). `apiUrl`로 주소만 만들고 브라우저가 내려받는다. */
type FileOp = Extract<AnyOp, { binary: string }>;
export type FileOperationId = FileOp['id'];
/**
 * 요청 이름으로 요청 정의를 고른다.
 * 계약에는 `.map`으로 만든 요청(예: submit·reject·request-changes, approve·apply)이 있어 한 정의의 id가 여러 이름의 합집합이다.
 * `Extract<ScreenOp, { id: Id }>`는 이런 정의를 버려 never가 된다(M3-05에서 발견). 그래서 「id 합집합에 Id가 들어 있는 정의」를 고른다.
 *
 */
// 정확히 같은 이름의 정의가 있으면 그것을 쓴다(이전 동작). 없을 때만 「id 합집합에 Id가 들어 있는 정의」를 찾는다.
// 순서가 중요하다: `get${string}`처럼 문자열 조립 id를 가진 정의가 다른 이름에 걸리지 않게 하려고.
type ExactOp<Id extends OperationId> = Extract<ScreenOp, { id: Id }>;
type UnionOp<Id extends OperationId> = ScreenOp extends infer O ? (O extends { id: infer I } ? (string extends I ? never : Id extends I ? O : never) : never) : never;
export type OperationOf<Id extends OperationId> = [ExactOp<Id>] extends [never] ? UnionOp<Id> : ExactOp<Id>;

type SchemaStatic<S> = S extends TSchema ? Static<S> : undefined;
type Responses<Id extends OperationId> = OperationOf<Id>['responses'];
type SuccessCode<Id extends OperationId> = Extract<keyof Responses<Id>, 200 | 201 | 202 | 204>;

/** 성공 응답 본문(본문 없는 204는 undefined) */
export type ResponseOf<Id extends OperationId> = SchemaStatic<Responses<Id>[SuccessCode<Id>]>;
export type BodyOf<Id extends OperationId> = OperationOf<Id> extends { body: infer B } ? SchemaStatic<B> : never;
export type QueryOf<Id extends OperationId> = OperationOf<Id> extends { query: infer Q } ? Partial<SchemaStatic<Q>> : never;

type PathParams<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | PathParams<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;
export type ParamsOf<Id extends OperationId> = [PathParams<OperationOf<Id>['path']>] extends [never]
  ? never
  : Record<PathParams<OperationOf<Id>['path']>, string>;
export type FileParamsOf<Id extends FileOperationId> = [PathParams<Extract<FileOp, { id: Id }>['path']>] extends [never]
  ? never
  : Record<PathParams<Extract<FileOp, { id: Id }>['path']>, string>;
/** 파일 요청의 query. 계약의 필수 필드는 필수 그대로 둔다(예: getReportPdf의 view). */
export type FileQueryOf<Id extends FileOperationId> = Extract<FileOp, { id: Id }> extends { query: infer Q } ? SchemaStatic<Q> : never;

/** 오류 응답 본문(contracts §1.1) */
export type ErrorBody = Static<typeof ErrorResponse>;
export type { ErrorCode };
