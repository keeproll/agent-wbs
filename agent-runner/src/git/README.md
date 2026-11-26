# Git 안전 계층 연결 안내

`GitRepository`는 Runner가 소유한 로컬 저장소를 다룬다. Git은 파일의 변경 기록을 남기는 도구다. 이 모듈은 웹 서버나 DB(데이터베이스)를 직접 부르지 않는다. Runner와 WBS가 소스를 공유하지 않는다는 설계 규칙을 지키며, 기존 API 클라이언트가 받은 값을 사용한다.

## 기본 사용

```ts
import { GitRepository } from './repository.ts';

const repo = await GitRepository.clone(runnerHome, projectId, repoUrl);
const baseCommit = await repo.head();
const latestMain = await repo.fetch();
const inputPath = await repo.checkoutInput('v1', latestMain);
const worktreePath = await repo.createWorktree('attempt-1', 'agent/TASK-0001-h2', latestMain);
// Agent가 커밋을 만든 뒤 실행한다.
const taskHead = await repo.importWorktree('attempt-1', 'agent/TASK-0001-h2');
const rejected = await repo.checkTask(latestMain, taskHead);
```

- `runnerHome`은 Runner 전용 절대 경로다. 저장소는 `repos/<projectId>`, 작업 폴더는 `worktrees/<projectId>`, 입력 사본은 `inputs/<projectId>` 아래에 놓인다.
- `createWorktree`는 작업 폴더라는 기존 메서드 이름을 유지하지만, 실제로는 Git 설정과 객체를 공유하지 않는 **독립 clone(별도 복사본)**을 만든다. 받은 SHA로 Runner의 Agent 브랜치를 먼저 만들고 그 브랜치만 복사하므로, `fetch()`로 방금 받은 최신 원격 커밋도 작업에 사용할 수 있다. 기존 브랜치는 덮어쓰지 않는다. 복사나 checkout이 실패하면 새 폴더·생성 기록·방금 만든 브랜치를 되돌린다. Git의 연결된 worktree는 `.git` 파일을 통해 Runner 설정까지 바꾸게 하므로 사용하지 않는다. 복사본의 원격 설정도 지운다. 가이드에 따라 ext4 파일 시스템을 확인하고 Windows 드라이브 경로도 거부한다.
- 저장소는 **bare 저장소**, 즉 작업 파일 없이 Git 기록만 보관하는 형태로 복사한다. 따라서 초기화 때 저장소 루트의 파일을 직접 덮어쓸 일이 없다.
- **SHA**는 커밋의 고유 번호다. 커밋을 받는 메서드는 줄인 번호나 브랜치 이름 대신 전체 SHA만 허용한다. `head()`는 로컬 `main`, `fetch()`는 새로 확인한 원격 `main`의 SHA를 돌려준다.
- `importWorktree`는 Git 객체 검증을 켜고 Agent의 결과 커밋만 `refs/agent-results/<작업 폴더 이름>`으로 가져온다. 내부 결과 참조만 강제 갱신하므로 amend(최근 커밋 수정)·rebase(기준 위로 이력 재작성) 뒤에도 다시 가져올 수 있다. 원격 강제 push는 하지 않는다. Agent의 Git 설정으로 checkout하거나 실행 명령을 고르지 않는다. 반환한 SHA로 `checkTask`를 실행한 뒤 후속 검사와 PR(병합 요청) 처리를 진행한다. Runner의 Agent 브랜치는 복사 시작점을 보관하므로 **PR 전송에도 반환한 결과 SHA를 사용**해야 한다. Runner의 `main`과 다른 Task 브랜치는 이동하지 않는다.
- Runner를 다시 시작하면 `GitRepository.open(runnerHome, projectId)`로 연다. `state/git/<projectId>.json`에 등록 원격 주소, Runner 설정의 지문인 SHA-256 해시, 작업 폴더별 `{ id, branch, startCommit }`을 기록한다. `startCommit`은 복사를 시작한 커밋이다. 원격 확인은 등록 주소로만 하며 모든 Runner Git 명령 전에 설정 지문을 검증한다. 설정이 달라지면 자동으로 받아들이거나 고치지 않고 실행을 중지한다.
- 이 등록 기록이 없는 구버전 캐시는 자동으로 신뢰하지 않는다. 실행을 중지하고 필요한 결과를 보존한 뒤 등록 주소로 새 관리 폴더에 다시 복사해야 한다. 같은 이름을 만들면서 기존 폴더를 덮어쓰지는 않는다.
- 작업 폴더 생성·삭제는 프로젝트별 `state/git/<projectId>.json.lock`으로 여러 객체·프로세스 사이에서도 하나씩 처리한다. 잠금 안에서 디스크의 최신 기록을 다시 읽고 완성된 파일로 한 번에 교체하므로 다른 Task의 기록을 덮어쓰지 않는다. 읽는 쪽도 최신 기록을 확인한다. 초기화·원격 갱신 등 다른 변경 작업의 순서는 Runner가 보장해야 한다.
- 잠금에는 `{ pid, bootId, startTime }`을 담는다. `pid`는 프로세스 번호, `bootId`는 현재 부팅의 고유 번호, `startTime`은 `/proc/<pid>/stat`에 기록된 프로세스 시작 값이다. 완성된 임시 파일을 먼저 쓰고 hard link(같은 파일에 이름을 추가하는 기능)로 잠금을 공개하므로 강제 종료돼도 빈 잠금을 만들지 않는다.
- 부팅 번호가 바뀌었거나, PID가 사라졌거나, 같은 PID의 시작 값이 달라졌으면 이전 주인의 잠금만 자동 회수한다. 새 프로세스에 재사용된 PID를 이전 주인으로 오인하지 않는다. 구버전의 PID만 적힌 잠금은 그 PID가 없다는 확인이 있을 때만 회수한다. 살아 있는 주인이나 확인 권한이 없는 경우, 잘못된 형식은 지우지 않고 30초 뒤 경로와 함께 보고한다.
- 회수 구간에는 Linux `flock`(util-linux 패키지)의 커널 잠금을 함께 사용하고 잠금 내용을 다시 대조한다. 다른 실행이 새로 얻은 잠금을 지우는 경쟁을 막으며 회수 도중 Runner가 강제 종료돼도 커널이 회수용 잠금을 해제한다. 이 PC에서 확인한 버전은 `flock 2.39.3`이다. `.lock.recover` 파일 자체는 정상적으로 남으므로 실행 중에는 삭제하지 않는다. 형식을 해석할 수 없는 잠금만 관련 실행이 모두 종료됐는지 확인한 뒤 수동 조치한다.

## 입력과 Task 검사

입력은 고정한 커밋의 `prototype/`만 Git 객체에서 읽는다. 파일 권한은 읽기 전용 `0444`, 폴더는 읽고 들어갈 수만 있는 `0555`다. 실행 파일도 실행하지 않는다. **심볼릭 링크(symlink)**는 다른 파일을 가리키는 지름길이므로 입력에 있으면 실패한다. **하위 모듈(submodule)**은 다른 저장소를 연결한 항목이므로 따라가지 않고 실패한다. 실패한 사본은 지운다.

**Git LFS**는 큰 파일을 Git 기록 밖에 보관하는 확장 도구다. LFS 포인터가 있으면 도구 설치를 확인하고 해당 커밋의 원본을 받아 크기와 해시를 검증한다. 도구나 원본이 없으면 포인터 파일만 복사해 성공했다고 하지 않는다. 일반 worktree를 만드는 과정에서는 저장소의 외부 변환 명령을 실행하지 않는다.

`checkTask(mainSha, taskHeadSha)`는 거부할 파일의 `{ path, reason }` 목록을 돌려준다. Task 검사 첫 단계에서 목록이 비었는지 확인해야 한다. 두 커밋의 공통 조상인 **merge-base**부터 비교하고, 이름 변경도 이전 경로와 새 경로를 모두 검사한다. `prototype/`, `.agentwbs/` 변경과 Task가 추가·수정·파일 종류를 바꾼 `.gitignore` 대상 파일을 거부한다. 기존에 강제 추가된 `.env.example`을 Task가 건드리지 않았다면 허용한다. 작업자가 `.gitignore`를 지워 우회하지 못하도록 기준 커밋의 규칙도 적용한다.

독립 clone은 Agent가 정상 Git 명령을 사용하면서 Runner 설정을 바꾸던 통로를 없앤다. 하지만 같은 운영체제 사용자가 sandbox 없이 실행되면 Runner의 폴더·등록 기록·토큰을 경로로 직접 읽고 쓸 수 있다. 읽기 전용 입력 사본의 권한도 다시 바꿀 수 있다. Q-08에서 실제 격리 수준을 정하고 검증해야 한다. 최소한 Agent에게 자기 작업 폴더만 쓰도록 허용하고 Runner의 `repos/`, `state/`, `inputs/`와 비밀값을 차단해야 하며, CI(자동 빌드·검사) 명령도 같은 경계에 넣어야 한다. 이번 로컬 테스트는 실제 CLI sandbox가 이 경계를 지킨다는 실증을 대신하지 않는다.

## 초기화와 M4-01 연결

M4-01의 `RunnerOptions.cleanup(command)` 안에서 프로세스 종료 확인과 GitHub 정리를 묶되, 이 모듈은 그중 로컬 Git 부분만 담당한다. `command.payload`는 기존 계약상 자유 형식이므로 연결하는 쪽이 `repoUrl`, `baseCommit`, `branches`를 검증하고 해당 저장소인지 확인한다. `worktrees`, `inputs`에는 그 프로젝트의 로컬 상태에 기록된 이름을 전달한다.

```ts
const result = await repo.reset({
  baseCommit: payload.baseCommit,
  branches: payload.branches,
  worktrees: recordedWorktreeIds,
  inputs: recordedInputIds,
});
```

초기화는 최신 원격 `main`을 읽고 `src/`, `contracts/`, `.agentwbs/`만 등록 기준 커밋으로 복원한다. 다른 파일과 최신 `prototype/`은 보존한다. 기존 기록 뒤에 새 커밋을 붙이므로 강제 push가 필요 없다. 아직 전송하지 않은 같은 초기화 커밋은 재시도 때 재사용한다. 기준 커밋이 `null`이면 저장소 정리를 생략하며, 필요한 로컬 폴더 삭제는 `removeInput`·`removeWorktree`로 따로 수행한다.

브랜치는 전달받은 목록 중 `agent/`로 시작하는 이름만 삭제한다. `agent/*` 전체를 검색해서 전달하면 안 된다. 예를 들어 서버가 `agent/TASK-0001-h2`만 기록했다면 다른 사람이 만든 `agent/manual`은 그대로 둔다. 작업 폴더는 생성 기록에 있는 이름만 삭제한다. 삭제 전에 프로세스 종료를 확인해야 한다. 폴더의 읽기·쓰기·진입 권한을 복구하고, 기록한 폴더 자체가 심볼릭 링크로 바뀌었으면 링크만 지운다. 상위 폴더의 링크는 계속 거부한다. Git 등록 정보나 `.git`이 먼저 사라져도 생성 기록이 있으므로 다시 정리할 수 있다.

`removeWorktree`는 생성 기록의 Agent 브랜치가 여전히 `startCommit`을 가리킬 때만 이전 값 비교로 삭제한다. 따라서 같은 Task 브랜치로 다음 시도 폴더를 만들 수 있다. 이미 다른 커밋으로 이동했거나 생성 기록이 없는 브랜치는 보존한다. 구버전의 폴더 이름만 있는 기록도 읽고 폴더는 정리하지만, 브랜치 이름과 시작점을 추측해 지우지는 않는다. 구버전 브랜치 정리는 서버가 명시한 초기화 브랜치 목록으로 처리한다.

잠금 주인 확인은 실행 중인 Agent·Git 하위 프로세스가 모두 종료됐다는 증거를 대신하지 않는다. 특히 Runner 강제 종료 뒤 정리할 때도 M4-01의 프로세스 그룹 종료 확인 순서를 지켜야 한다.

정리 중 하나가 실패해도 다른 폴더·입력·브랜치 정리는 계속한다. 마지막에 `GitCleanupError`가 나면 `failures`의 항목 이름·경로·원인을 보고하고 정리 완료를 전송하지 않는다. 예를 들어 다른 OS 사용자가 소유한 파일은 관리자에게 권한 수정을 요청한 뒤 같은 명령을 재시도한다. 생성 기록이 없는 폴더는 자동 삭제하지 않는다.

원격 쓰기는 M4-04 GitHub 어댑터의 책임이다. 외부 쓰기 권한을 확인한 뒤 열린 PR을 닫고, 서버가 기록한 원격 Agent 브랜치만 삭제한다. `result.commit`이 원격 `main`과 같으면 전송할 변경이 없다. 되돌림 커밋을 전송할 때는 **등록된 저장소**에서 GitHub API로 방금 확인한 `main` SHA가 로컬 커밋의 부모 SHA와 같은지 먼저 대조하고 일반 push를 사용해야 한다. 이 모듈은 초기화 대상 밖의 파일이 새로 받은 `main`과 같은지도 검증한다. 이 함수만 끝났다고 전체 정리 완료나 프로세스 종료 증거를 보고하면 안 된다. 원격 `main`이 다시 움직이면 `reset`을 재시도하여 최신 입력을 보존하는 커밋을 만든다.

## 검증

`pnpm -C agent-runner test -- git`은 실제 외부 저장소에 접속하지 않고 로컬 bare 저장소로 검증한다. 임시 테스트 폴더는 운영체제의 `os.tmpdir()`를 사용하므로 다른 사용자와 CI에서도 실행할 수 있다. 이 작업의 증거를 남길 때는 `TMPDIR`을 지정된 보관 폴더 안의 ext4 경로로 설정한다. 테스트가 만든 폴더는 종료할 때 지운다.

## 초기화 정리 연결(M4 통합)

- **로컬 저장소 이름**은 `repositoryIdFor(repoUrl)`로 만든다(`src/git/identity.ts`).
  - 서버 DB와 같은 규칙으로 주소를 정규화한다: 공백·끝 `/`·끝 `.git` 제거, 소문자.
  - 왜: 정리 명령은 `repoUrl`만 알려 준다. clone하는 쪽과 정리하는 쪽이 같은 이름을 써야 한다.
- 정리 명령의 `repoUrl`과 등록 원격(`source()`)이 다르면 정리를 중지한다.
- **생성 차단**: `beginReset()`이 등록 기록에 `resetting`을 남긴다.
  - 그동안 `createWorktree`·`checkoutInput`은 실패한다.
  - `endReset()`은 생성 기록·작업 폴더·입력 사본이 하나도 남지 않았을 때만 차단을 푼다.
  - 왜: 목록을 읽은 뒤 생긴 폴더가 남아 있는데 「정리 완료」를 보고하면 안 된다(교차 리뷰 P1-6).
  - 기록이 디스크에 있으므로 강제 종료 뒤에도 유지된다. 정리 명령을 다시 실행하면 풀린다.
- **push**: `pushCommit(commit, branch, authorization?)`은 일반 push만 한다(강제 push 없음).
  - 로컬 브랜치를 옮기지 않는다.
  - 인증 헤더는 명령 인자가 아니라 환경 변수(`GIT_CONFIG_*`)로 넘긴다.

## 입력 복사와 초기화의 직렬화(2차 재리뷰 N2)

- `checkoutInput`은 복사 전체를 **프로젝트 잠금**(`state/git/<projectId>.json.lock`) 안에서 한다. 작업 폴더 생성·삭제, 초기화 시작·끝과 같은 잠금이다.
  - 죽은 주인의 잠금은 기존 방식(boot ID·PID·시작 시각·flock 대조)으로 자동 회수된다.
- 복사는 임시 폴더 `inputs/<projectId>/.copy-<입력>-<세대>-<uuid>`에 쓴다.
  - 잠금 안에서 초기화 세대가 시작 때와 같은지 확인한다.
  - 그다음 **이름 바꾸기 한 번으로만** 공개한다.
  - 실패하면 자기 임시 폴더만 지운다. 공개 경로는 지우지 않는다.
  - 왜: 예전에는 실패한 옛 복사가 같은 이름의 새 정상 입력을 지울 수 있었다.
- `beginReset`의 순서:
  1. 이 프로세스에서 진행 중인 복사에 취소 신호를 보낸다.
  2. 잠금을 기다린다. 복사가 취소를 보고 끝나거나, 죽은 복사의 잠금이 회수될 때까지다.
  3. 세대를 올리고 남은 임시 폴더를 지운다.
- `GitRepository.open`(시작)도 잠금을 잡고 공개되지 않은 임시 폴더를 지운다. 단, 이 프로세스에서 진행 중인 복사가 있으면 건드리지 않는다.
- 결과:
  - 초기화가 done을 보고한 뒤에는 옛 복사가 입력을 공개할 수 없다.
  - 복사 중 강제 종료되면 공개 안 된 임시 폴더만 남는다. 다음 초기화나 다시 열기가 지운다.
- 주의: 다른 프로세스의 복사는 취소 신호를 받지 못한다. 그 복사가 잠금 대기 한도(30초)보다 오래 걸리면 초기화가 실패하고, 서버가 재시도한다.
