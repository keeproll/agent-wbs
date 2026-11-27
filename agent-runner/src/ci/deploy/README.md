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

## 한 환경에서는 한 번에 하나 (재리뷰 원칙 1)

- 같은 환경(배포 상태 폴더 `<AWBS_HOME>/ci/deploy/`)의 배포 확인은 들어온 순서대로 하나씩 실행한다.
  - 마지막 통과 기록 읽기부터 단계 실행, 접속 확인, 복구, 상태 저장까지가 한 구간이다.
  - 왜: 무거운 작업 번호표만으로는 순서가 보장되지 않는다. 앞 배포의 복구 전에 뒤 배포가 끼어들면, 복구가 더 새 정상 배포를 되돌린다.
  - 다른 Runner 프로세스와의 배타는 데이터 폴더 잠금(한 `AWBS_HOME`에 Runner 하나)이 맡는다.
- 배포 확인을 시작할 때마다 `state.json`의 `seq`(단조 증가 배포 순번)를 하나 올려 먼저 저장한다.
- 복구 직전에 순번을 다시 확인한다. 자기보다 새 배포가 시작됐으면 복구·이미지 정리·상태 저장을 하지 않는다.
  - note에는 「더 새 배포가 시작되어 복구하지 않음」을 적고, `deployRestore`는 보내지 않는다.
- 서버도 서비스 없음 경보를 그 환경의 최신 배포 실행(`run_no`) 결과로만 열고 닫는다.
  - 늦게 도착한 옛 실행의 결과는 실행 이력으로만 남는다.
  - 왜: 벽시계가 아니라 순번으로 정해야 시계가 뒤로 가도, 보고가 늦게 와도 현재 서비스 상태를 뒤집지 않는다.

## Runner가 붙이는 단계 이름

- `runner:target`, `runner:url-check`, `runner:screenshots`, `runner:restore`는 Runner가 붙이는 단계다.
- 정의의 단계 이름은 영소문자·숫자·`-`만 쓰므로 `:`이 든 이름과 겹치지 않는다.
  - 왜: 이름이 겹치면 서버가 보고를 `VALIDATION_FAILED`로 거부해 실제 결과가 남지 않는다(원칙 D).

## 실패했을 때

- 실패한 단계와 로그 발췌를 보고한다.
- 로그에 포트 충돌 문구가 있으면 note에 「포트 8080 사용 중」처럼 원인을 적는다.
  - 인식하는 문구: `EADDRINUSE`, `address already in use`, `port is already allocated`, `ports are not available`
  - 근거: 프로토타입의 배포 확인 실패 예(P L4758)와 리뷰에서 실제 Docker가 낸 문구.
- 실패하면 마지막으로 통과한 커밋을 자동으로 다시 기동한다(조정자 결정 7, UAT-CI-05 a).
  - 마지막 통과 커밋은 `<AWBS_HOME>/ci/deploy/state.json`의 `lastPass`에 있다.
  - 그 커밋 자신의 정의(`.agentwbs/pipeline.yaml`)로 deploy 단계를 새 사본에서 다시 실행한다. 이미지 이름도 그 커밋의 것을 쓴다.
    - 왜: 이전 정상 배포는 그 커밋의 정의로 만든 것이다. 새 정의로 옛 커밋을 띄우면 같은 서비스가 아니다.
  - 이어서 `<URL>/api/health`와 `<URL>/`에 접속 확인한다.
  - 결과는 `runner:restore` 단계와 결과의 `restore`(`{ commit, status, detail }`)에 남긴다.
  - note에는 실제로 확인한 결과만 적는다.
    - 통과: 「마지막 정상 커밋 (커밋)을 다시 기동해 접속 확인 통과」
    - 실패: 「마지막 정상 커밋 (커밋) 복구 실패 — 서비스 없음(이유)」
  - 복구에 성공해도 이번 배포 확인 결과는 실패다. 실패 알림(「빌드 실패」)은 서버가 보낸다.
  - 결과 보고에 `deployRestore: { commit, status }`를 함께 보낸다.
    - `pass`: 복구 통과, `fail`: 복구 실패, `none`: 복구할 직전 통과 배포 없음(`commit`은 null).
- 서버는 `deployRestore`가 `fail`이나 `none`이면 「서비스 없음」으로 보고 따로 알린다(조정자 결정 11).
  - 높은 우선순위 경보(`ci:serviceDown`, severity `critical`)를 만든다.
  - 알림 이벤트 `serviceDown`을 만든다. 일반 「빌드 실패」 알림과 별개다. 알림 규칙 켜기·끄기와 무관하게, 전체 알림이 켜져 있으면 보낸다.
  - 다음 배포 확인이 통과하면 경보와 알림을 해소한다.
  - Telegram 전이 알림 대응표에 `serviceDown`을 넣는 일은 M6·M7 통합 때 한다.
- 마지막 통과 기록이 없으면 복구하지 않는다.
  - 대신 `/api/health`에 한 번 접속해 본 결과를 적는다.
    - 응답 없음: 「복구할 직전 통과 배포가 없음 — 서비스 없음」
    - 응답함: 「… — 실패 뒤 /api/health 응답 200(응답한 서비스의 커밋은 확인하지 않음)」
- `runner:target`에서 멈춘 실패는 아무것도 바꾸지 않았으므로 복구하지 않는다.
- 이전 서비스를 띄운 채 새 서비스를 확인하는 무중단 교체는 Q-15(배포 대상) 결정 뒤에 한다.

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
