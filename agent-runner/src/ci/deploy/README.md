# ④ 배포 확인 안내

④ 배포 확인은 「Web Service가 정상 기동하고 브라우저로 접속된다」를 확인하는 단계다(G L477).
팀장이 화면에서 요청하면 서버가 `deploy_check` job을 만들고, Runner가 `runDeployCheck`로 실행한다.
M7-06에서 실제 실행기·API에 연결한다.

## 대상: 이 PC의 docker compose만

- 배포 대상을 어디로 할지는 아직 owner가 정하지 않았다(Q-15).
- 그래서 기본값대로 이 PC(loopback 주소: `localhost`, `127.0.0.1`, `[::1]`)의 docker compose만 확인한다.
- 정책의 `ci.deployUrl`이 없거나 다른 주소면 아무것도 실행하지 않고 `runner:target` 단계 실패로 남긴다.
  - 왜: 정해지지 않은 원격 서버에 몰래 배포하면 안 된다. 실패로 남겨야 팀장이 설정을 보고 고칠 수 있다.

## 어느 정의를 쓰나

- job의 `commit`(요청 시점의 main) 자신의 `.agentwbs/pipeline.yaml`을 쓴다.
  - 왜: 나중에 같은 커밋 해시로 다시 빌드해도 같은 결과가 나와야 한다(G L486).
- main에 들어가지 않은 커밋은 배포 확인하지 않는다. 시작 보고도 하지 않는다.
  - 왜: 병합되지 않은 브랜치가 배포 확인을 통과한 것처럼 보이면 안 된다.

## 무엇을 실행하나

1. 커밋을 새 사본에 꺼낸다.
2. 정의의 `deploy` 단계를 순서대로 실행한다. 보통 운영 빌드(Docker 이미지) → compose up → Playwright 접속이다.
   - 단계에는 아래 환경 변수를 준다.
     - `AWBS_DEPLOY_COMMIT`: 배포할 커밋
     - `AWBS_DEPLOY_TAG`: 만들 이미지 이름(`agentwbs-deploy:<커밋 앞 12자>`)
     - `AWBS_DEPLOY_URL`: 접속할 주소
     - `COMPOSE_PROJECT_NAME`: `agentwbs-deploy`로 고정. 이전 배포 확인의 컨테이너를 같은 이름으로 바꿔 띄운다.
     - `AWBS_REPORT`, `AWBS_EVIDENCE_DIR`: ③과 같다(night/README.md 「단계 결과 보고서 계약」).
   - 이 환경 변수 이름과 보고서 형식은 승인된 계약이다(조정자 결정 4).
   - 배포 단계는 재시도하지 않는다.
   - 각 단계 뒤에 사본이 배포 커밋과 같은지 다시 확인한다. 단계가 커밋 파일을 바꿨으면 그 단계는 실패다(원칙 C).
3. `runner:url-check`: Runner가 직접 `<URL>/api/health`와 `<URL>/`에 접속해 200이 오는지 본다.
   - 응답이 올 때까지 정한 시간(기본 60초) 안에서 다시 확인한다.
   - 시간은 단조 시계(뒤로 가지 않는 시계)로 잰다. 왜: 이 PC는 벽시계가 뒤로 간다.
4. `runner:screenshots`: 브라우저 접속 단계가 보고서 `screenshots`에 적은 PNG 파일이 실제로 있는지 확인한다.
   - 보고서 형식은 night/README.md 「단계 결과 보고서 계약」의 `screenshots[]`다.
   - 한 장도 없거나 PNG가 아니면 실패다.
   - 왜: 「정상 기동 + 브라우저 접속」의 근거는 Runner가 확인한 응답과 스크린샷이다. 단계가 「통과」라고 말한 것만으로는 근거가 아니다(G L466).

## Runner가 붙이는 단계 이름

- `runner:target`, `runner:url-check`, `runner:screenshots`는 Runner가 붙이는 단계다.
- 정의의 단계 이름은 영소문자·숫자·`-`만 쓰므로 `:`이 든 이름과 겹치지 않는다.
  - 왜: 이름이 겹치면 서버가 보고를 `VALIDATION_FAILED`로 거부해 실제 결과가 남지 않는다(원칙 D).

## 실패했을 때

- 실패한 단계와 로그 발췌를 보고한다.
- 로그에 포트 충돌 문구가 있으면 note에 「포트 8080 사용 중」처럼 원인을 적는다.
  - 인식하는 문구: `EADDRINUSE`, `address already in use`, `port is already allocated`, `ports are not available`
  - 근거: 프로토타입의 배포 확인 실패 예(P L4758)와 리뷰에서 실제 Docker가 낸 문구.
- 이전 서비스가 유지되는지는 짐작하지 않는다. 실패 뒤 `<URL>/api/health`에 실제로 한 번 접속해 본 결과만 적는다(원칙 C).
  - 응답하면: 「실패 뒤 접속 확인: /api/health 응답 200(응답한 서비스의 커밋은 확인하지 않음)」
  - 응답하지 않으면: 「실패 뒤 접속 확인: 응답 없음(…)」
  - 왜: 이미지가 남아 있다고 서비스가 돌고 있는 것은 아니다. compose up은 기존 컨테이너를 먼저 바꾼 뒤 실패할 수 있다.
- 직전에 통과한 배포가 있으면 「직전 통과 커밋 (커밋)의 이미지는 남겨 둠」을 적고 결과의 `previous`에 그 커밋과 응답 여부를 담는다.
  - 되돌릴 때는 그 커밋 해시로 다시 배포 확인을 요청한다(G L489).
- 실패 때 이전 정상 배포를 자동으로 되살리는 일은 아직 하지 않는다(UAT-CI-05 a의 「이전 정상 배포 유지」는 남은 일로 보고함).

## 보존 정책

- 로그·스크린샷은 ③과 같이 `<AWBS_HOME>/runs/<실행 ID>/`에 두고 30일 뒤 지운다.
- 로컬 Docker 이미지는 다음 배포 확인까지만 남긴다(G L489).
  - 통과하면 이번 이미지만 남기고 이전 이미지를 지운다.
  - 실패하면 직전 통과 이미지와 이번 이미지를 남기고 나머지를 지운다. 이번 이미지는 다음 배포 확인 때 지운다.
  - 지우지 못한 이미지는 기록에 남겨 다음에 다시 지운다.
- 이미지 기록은 `<AWBS_HOME>/ci/deploy/state.json`에 있다.
- 이미지를 컨테이너 저장소(GHCR 등)에 올리지 않는다(G L485).

## 서버에 보내는 순서

1. `POST /api/runner/ci/runs` — job의 `jobId`·`fence`, `stage: deploy`, `trigger: 팀장 요청`, `headSha`=배포 커밋
2. `PATCH /api/runner/ci/runs/:id` — `{ fence, status: run }`
3. `PATCH /api/runner/ci/runs/:id` — 결과: `status`, `steps`, `url`, `note`, `logExcerpt`, `artifacts`(스크린샷 위치 포함), `finishedAt`

모든 갱신에 job의 fence를 넣는다. 낡은 fence면 서버가 409 LEASE_LOST로 거절한다.
