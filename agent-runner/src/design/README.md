# Runner 설계 계약 해석

`parseContracts()`는 호출자가 특정 commit(내용이 고정된 Git 저장소 버전)에서 읽은 `contracts/` 파일을 받는다.
파일 경로는 저장소 안의 상대 경로만 허용한다.
왜: 다른 폴더의 파일을 계약처럼 보고하거나, 보고한 버전과 실제 파일이 달라지는 일을 막기 위해서다.
이 모듈은 파일 안의 코드나 SQL(데이터베이스에 보내는 명령)을 실행하지 않는다.

`buildDesignSnapshot()`은 해석 결과와 실제 구현에서 추출한 명세를 대조한다.
`reportDesignSnapshot()`은 결과를 기존 Outbox(디스크에 저장하는 보고 대기함)에 넣는다.
왜: 서버 연결이 끊어져도 보고를 잃지 않고 같은 멱등 키로 다시 보낼 수 있어야 하기 때문이다.
호출자가 이미 사용하는 Outbox 전송 주기를 그대로 쓴다.

## 해석 범위

- OpenAPI 3.1: REST API(HTTP 요청으로 자원을 주고받는 방식)의 경로, 요청 파라미터, 요청 본문, 응답과 헤더를 읽는다.
- AsyncAPI 3.0: 채널 주소와 메시지의 JSON Schema(데이터 필드와 타입을 적는 형식)를 읽는다.
  Kafka 메시지도 JSON Schema이면 같은 방식으로 읽는다.
  Q-14 A 결정에 따라 스키마 레지스트리(메시지 형식의 버전을 보관하는 외부 서버)는 연결하지 않는다.
- PostgreSQL SQL: 파일 이름순으로 마이그레이션(저장 구조 변경 파일)을 누적한다.
  테이블·컬럼·기본키·외래키·인덱스를 읽는다.
  `CREATE TABLE`, 지원하는 `ALTER TABLE`, `CREATE INDEX`, `DROP TABLE`, `DROP INDEX`, 컬럼 설명을 반영한다.

Avro·Protobuf, Neo4j·QuestDB·Redis 등 전용 해석기가 없는 형식은 원문을 남긴다.
왜: 확정하지 않은 형식을 임의로 해석하면 실제로 확인하지 않은 내용을 일치로 보고할 수 있기 때문이다.
원문은 `files[].raw`에 둔다.
화면용 `items[].content`는 M6-05 계약의 REST·message·postgres 구조를 따른다.
원문만 있는 항목의 `content`는 `{}`다.

## 실제 구현에서 추출하기

호출자는 `openapi`, `asyncapi`, `sql`별 `DesignExtractor` 함수를 제공할 수 있다.
함수는 `{commit, ref, item}`을 받아 `{fields: [{path, type, required}]}` 또는 `null`을 돌려준다.
`path`는 JSON Pointer(중첩 필드를 가리키는 고정 주소)다.
예를 들어 SQL의 `id` 컬럼은 `/id`다.
OpenAPI의 JSON 요청 필드는 `/requestBody/content/application~1json/id`다.
`~1`은 주소 안의 `/`를 뜻한다.
배열 원소는 `/*`로 표시한다.
실제 추출기에서도 계약 해석기와 같은 주소와 타입 표기를 써야 한다.
SQL 타입 문자열은 설치한 SQL 파서의 `toSql.dataType()` 결과다.

실제 명세를 확인할 수 없으면 `null`을 돌려준다.
어댑터가 없거나 예외가 나거나 결과 형식이 잘못되어도 `extracted: null`과 `compat: unchecked`를 보고한다.
왜: 추출 실패를 불일치 0건이나 성공으로 잘못 표시하지 않기 위해서다.
이번 작업에서는 fake(외부 시스템 대신 고정 결과를 주는 구현)로 검증한다.
실제 코드 생성 명령·Drizzle·DB 조회 연결은 실행 격리 결정 뒤 호출자가 연결해야 한다.

필드 삭제·타입 변경·필수화는 `breaking` 참고값이다.
선택 필드 추가·필수 해제는 `compatible` 참고값이다.
최종 판정은 서버가 `contract`와 `extracted`를 비교해서 내린다.
왜: Runner마다 판정이 달라져도 서버의 승인 규칙이 유지되어야 하기 때문이다.

외부·순환 참조와 지원하지 않는 JSON Schema 조합 규칙은 `unchecked`로 남긴다.
SQL 파일을 하나라도 못 읽거나 지원하지 않는 SQL 구문이 있으면 SQL 파일 전체를 읽기 실패로 보고한다.
왜: 일부 마이그레이션만 반영한 저장 구조를 최종 구조인 것처럼 대조하지 않기 위해서다.
지원하지 않는 PostgreSQL 문법을 실제 DB에서 임의로 실행해 확인하지 않는다.
`CASCADE` 연쇄 삭제와 의존 인덱스·제약·외래키가 있는 컬럼 삭제도 읽기 실패로 남긴다.
왜: 의존 항목을 정확히 제거하지 않고 이전 정보를 계속 보여주면 잘못된 설계가 되기 때문이다.

## 브랜치와 반영 결과

`ref`를 생략하면 `main`이다.
다른 브랜치의 파일은 `draft`로 보고한다.
왜: 진행 중인 변경을 main의 확정 설계와 섞으면 안 되기 때문이다.

`design_apply`의 결과도 실제 결과 commit과 같은 `jobId`·`fence`로 보고한다.
fence는 낡은 Runner 보고를 막는 번호표다.
이 모듈은 계약 파일을 고치거나 커밋하거나 서버의 불일치를 직접 완료 처리하지 않는다.
서버가 main 결과 보고를 확인한 뒤 상태를 바꾼다.

```sh
pnpm -C agent-runner test -- design
```
