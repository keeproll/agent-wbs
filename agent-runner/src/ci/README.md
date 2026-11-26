# ① Task 검사 연결 안내

CI(Continuous Integration, 코드를 자동으로 빌드하고 검사하는 과정)의 ① 경로는 `runTaskCheck`다.
M7-06에서 기존 자리표시 대신 호출한다.
지금은 job 처리 흐름이나 서버의 Gate(완료 전에 통과해야 하는 조건 묶음)를 바꾸지 않는다.

## 정의 형식

YAML(사람이 읽기 쉬운 설정 파일 형식)의 `version`은 `1`이다.
`stages`에는 `task`, `int`, `night`, `deploy` 네 목록을 넣는다.
각 목록의 단계에는 `name`과 `argv`만 넣는다.
argv는 실행 파일과 인자를 따로 담은 문자열 배열이다.
왜: shell(명령 문자열을 해석하는 프로그램)로 문자열을 조합하면 인자가 새 명령으로 바뀔 수 있다.

①의 `name`은 아래 여섯 개를 이 순서로 모두 적는다.
보호 경로 검사는 Runner가 그보다 먼저 실행한다.
왜: 정의에서 필수 검사를 빼거나 보호 경로 검사를 우회하지 못하게 한다.

```yaml
version: 1
stages:
  task:
    - name: install
      argv: [pnpm, install, --frozen-lockfile]
    - name: typecheck
      argv: [pnpm, typecheck]
    - name: lint
      argv: [pnpm, lint]
    - name: unit
      argv: [pnpm, test]
    - name: build
      argv: [pnpm, build]
    - name: contract
      argv: [pnpm, test:contract]
  int:
    - name: integration
      argv: [node, fake-integration.mjs]
  night:
    - name: nightly
      argv: [node, fake-nightly.mjs]
  deploy:
    - name: health
      argv: [node, fake-health.mjs]
```

위 코드는 형식 예시다.
②③④의 명령은 fake(실제 실행 대신 쓰는 가짜) 이름이다.
운영 기본값으로 설치하지 않는다.
②③④ 목록은 비어 있으면 안 되며 이름이 목록 안에서 겹치면 안 된다.
구체적인 명령과 대상은 각 후속 마일스톤에서 정한다.

알 수 없는 필드, 다른 버전, 빈 명령, 중복 YAML 키, 별칭, 알 수 없는 태그, 여러 문서는 거부한다.
정의 크기가 256 KiB(262,144 바이트)를 넘으면 거부한다.
왜: 잘못 적은 설정을 일부만 받아 실행하지 않도록 한다.
별칭은 다른 값을 이름으로 재사용하는 YAML 문법이다.
이 형식에는 필요하지 않아 허용하지 않는다.

## 실행과 근거

`GitRepository.mainPipeline()`이 등록된 원격의 main을 가져온다.
그 커밋의 `.agentwbs/pipeline.yaml`을 Git 객체에서 읽는다.
SHA(파일이나 커밋 내용을 구별하는 해시 값)는 두 가지를 구분해 반환한다.
`baseSha`는 고정한 main 커밋이다.
`pipelineSha`는 그 커밋에 있는 정의 파일의 blob(파일 내용 객체) SHA다.
왜: 실행 중 main이 바뀌어도 어떤 정의로 검사했는지 다시 확인할 수 있어야 한다.

검사 전 Agent의 결과 커밋을 Runner 저장소에 가져와 `headSha`로 고정한다.
보호 경로와 빌드 결과물 검사는 기존 `GitRepository.checkTask`를 쓴다.
두 커밋의 merge-base(브랜치가 갈라진 공통 조상)부터 비교한다.
검사 전과 각 명령 앞뒤에 작업 파일이 고정한 커밋과 같은지도 확인한다.
Agent index(다음 커밋에 넣을 파일 목록)의 숨김 설정은 믿지 않는다.
Runner가 만든 임시 index로 직접 대조한다.
왜: 커밋하지 않은 테스트 삭제로 다른 코드를 검사하고 통과했다고 보고하면 안 된다.

공유 `HeavySemaphore`의 번호표를 받은 뒤 명령을 실행한다.
①도 Agent와 같은 무거운 작업 상한을 지켜야 하기 때문이다.
`unit`과 `contract`의 테스트 실패는 한 번만 재시도한다.
재시도에서만 통과하면 `flakyCandidates`에 불안정 후보 이름을 남긴다.
실행 오류와 중단은 테스트 실패로 재시도하지 않는다.
실패한 단계 다음의 명령은 실행하지 않는다.
결과에는 단계별 종료 코드, 출력, 소요 시간과 `failStep`을 남긴다.
출력과 변경 근거는 기존 비밀값 가리기 함수를 적용한다.
호출자는 `redact`에 자신이 알고 있는 비밀값을 추가할 수 있다.

Q-08의 격리 방식이 정해지기 전에는 `execute`에 fake만 전달한다.
기본 실행기는 제공하지 않는다.
실제 실행기를 연결하는 쪽은 자격 증명 격리, 프로세스 그룹 등록, 슬롯 획득, 중단과 자손 종료 확인을 맡는다.
`execute`는 프로세스가 모두 끝난 뒤 반환해야 한다.
왜: ①도 Agent와 같은 자격 증명 경계를 지켜야 하고 살아 있는 자손의 번호표를 반납하면 안 된다.

## 테스트 삭제와 QA

QA(Quality Assurance, 수용 기준을 검증하는 Agent)의 확인 묶음으로 `result.testReview`를 넘긴다.
이 묶음은 `baseSha`와 `headSha`, 변경 전후 blob SHA, 변경 경로, diff(변경 전후 비교문)를 담는다.
테스트 삭제는 자동 실패로 만들지 않는다.
건너뛰기 추가나 단언 제거는 기존 파일의 수정 근거로 남는다.
이름 변경도 이전 파일의 삭제 근거로 남는다.
왜: G L480과 coordinator의 확인에 따라 삭제·약화의 타당성은 검증 Agent가 명시적으로 판단해야 한다.

테스트 파일 이름은 프로젝트마다 다르다.
따라서 기존 파일의 삭제·수정은 모두 확인 후보에 포함한다.
일반 소스 수정도 들어갈 수 있다.
왜: 이름 규칙만 보고 찾으면 독자적인 이름의 테스트나 바이너리 근거가 빠질 수 있다.
새 파일 추가만으로는 기존 테스트 삭제·약화를 만들지 않으므로 이 목록에서 뺀다.

`testReview.required`가 참이면 기계 검사 `pass`만으로 Gate 근거로 삼으면 안 된다.
M7-06 연결부는 이 묶음을 QA 작업에 전달해야 한다.
같은 SHA의 목록을 검증 Agent가 명시적으로 확인한 기록도 서버에 남겨야 한다.
확인 기록이 없거나 검사 대상 SHA가 바뀌면 Gate에서 받아들이면 안 된다.
이 모듈은 QA 확인 여부를 대신 판정하거나 서버 기록을 만들어 내지 않는다.
API(프로그램 사이 통신 규칙) 보고와 영속 보관은 M7-06에서 기존 client·outbox(재전송할 보고를 보관하는 대기열)로 연결한다.
왜: M7-01은 실제 ① 경로를 준비하고 자리표시 제거는 M7-06이 맡는다.

## 검증

`pnpm -C agent-runner test -- ci-task`로 검사한다.
외부 서비스 대신 로컬 Git 저장소와 fake 명령을 쓴다.
근거 보관 폴더 아래에 `TMPDIR`을 지정하면 임시 시험 저장소도 그 폴더에 만든 뒤 삭제한다.
