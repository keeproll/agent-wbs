# DB 시험 준비

DB(데이터베이스) 시험에는 자기 전용 PostgreSQL 16 컨테이너와 포트를 사용한다.
`TEST_DATABASE_URL`의 DB 이름은 `awbs_test_`로 시작해야 한다.
`pnpm test:db`는 이 DB를 삭제하고 다시 만든다.
다른 개발 DB를 지우지 않도록 이름과 실제 연결 대상을 검사한다.

`recreateTestDatabase`는 `template0`에서 UTF8·C.UTF-8로 DB를 만든다.
`LC_COLLATE`는 문자열 정렬 규칙이다.
`LC_CTYPE`는 문자 분류 규칙이다.
둘을 C.UTF-8로 고정한다.
컨테이너의 기본 언어가 달라도 모델 목록 순서와 한글 정규식 결과가 같아야 하기 때문이다.

마이그레이션의 `journal`은 적용 순서와 시각을 적은 목록이다.
병합 직전에는 새 항목을 마지막 순번으로 두고 `when`을 기존 최댓값보다 크게 정한다.
SQL 파일 이름과 snapshot(DB 구조 기록)의 연결도 함께 맞춘다.
이미 적용한 항목보다 작은 `when`이 나중에 들어오면 Drizzle이 이를 건너뛸 수 있기 때문이다.
`runMigrations`는 실행 후 모든 journal 항목의 hash(파일 내용의 고유 번호)를 DB와 대조한다.
빠진 항목이 있으면 서버를 시작하지 않고 오류로 멈춘다.
오류가 나면 운영 데이터를 지우지 말고 마이그레이션 적용 순서를 먼저 바로잡는다.
