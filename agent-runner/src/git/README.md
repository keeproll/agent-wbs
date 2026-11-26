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
- `createWorktree`는 작업 폴더라는 기존 메서드 이름을 유지하지만, 실제로는 Git 설정과 객체를 공유하지 않는 **독립 clone(별도 복사본)**을 만든다. Git의 연결된 worktree는 `.git` 파일을 통해 Runner 설정까지 바꾸게 하므로 사용하지 않는다. 복사본의 원격 설정도 지운다. 가이드에 따라 ext4 파일 시스템을 확인하고 Windows 드라이브 경로도 거부한다.
- 저장소는 **bare 저장소**, 즉 작업 파일 없이 Git 기록만 보관하는 형태로 복사한다. 따라서 초기화 때 저장소 루트의 파일을 직접 덮어쓸 일이 없다.
- **SHA**는 커밋의 고유 번호다. 커밋을 받는 메서드는 줄인 번호나 브랜치 이름 대신 전체 SHA만 허용한다. `head()`는 로컬 `main`, `fetch()`는 새로 확인한 원격 `main`의 SHA를 돌려준다.
- `importWorktree`는 Git 객체 검증을 켜고 Agent의 결과 커밋만 `refs/agent-results/<작업 폴더 이름>`으로 가져온다. Agent의 Git 설정으로 checkout하거나 실행 명령을 고르지 않는다. 반환한 SHA로 `checkTask`를 실행한 뒤 후속 검사와 PR(병합 요청) 처리를 진행한다. Agent가 만든 브랜치는 복사본에만 있으며 Runner의 `main`과 다른 Task 브랜치에 영향을 주지 않는다.
- Runner를 다시 시작하면 `GitRepository.open(runnerHome, projectId)`로 연다. `state/git/<projectId>.json`에 등록 원격 주소, Runner 설정의 지문인 SHA-256 해시, 생성한 작업 폴더 목록을 기록한다. 원격 확인은 등록 주소로만 하며 모든 Runner Git 명령 전에 설정 지문을 검증한다. 설정이 달라지면 자동으로 받아들이거나 고치지 않고 실행을 중지한다.
- 이 등록 기록이 없는 구버전 캐시는 자동으로 신뢰하지 않는다. 실행을 중지하고 필요한 결과를 보존한 뒤 등록 주소로 새 관리 폴더에 다시 복사해야 한다. 같은 이름을 만들면서 기존 폴더를 덮어쓰지는 않는다. 같은 `repositoryId`의 메서드 호출은 Runner가 하나씩 처리해야 한다.

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

정리 중 하나가 실패해도 다른 폴더·입력·브랜치 정리는 계속한다. 마지막에 `GitCleanupError`가 나면 `failures`의 항목 이름·경로·원인을 보고하고 정리 완료를 전송하지 않는다. 예를 들어 다른 OS 사용자가 소유한 파일은 관리자에게 권한 수정을 요청한 뒤 같은 명령을 재시도한다. 생성 기록이 없는 폴더는 자동 삭제하지 않는다.

원격 쓰기는 M4-04 GitHub 어댑터의 책임이다. 외부 쓰기 권한을 확인한 뒤 열린 PR을 닫고, 서버가 기록한 원격 Agent 브랜치만 삭제한다. `result.commit`이 원격 `main`과 같으면 전송할 변경이 없다. 되돌림 커밋을 전송할 때는 **등록된 저장소**에서 GitHub API로 방금 확인한 `main` SHA가 로컬 커밋의 부모 SHA와 같은지 먼저 대조하고 일반 push를 사용해야 한다. 이 모듈은 초기화 대상 밖의 파일이 새로 받은 `main`과 같은지도 검증한다. 이 함수만 끝났다고 전체 정리 완료나 프로세스 종료 증거를 보고하면 안 된다. 원격 `main`이 다시 움직이면 `reset`을 재시도하여 최신 입력을 보존하는 커밋을 만든다.

## 검증

`pnpm -C agent-runner test -- git`은 실제 외부 저장소에 접속하지 않고 로컬 bare 저장소로 검증한다. 임시 테스트 폴더는 운영체제의 `os.tmpdir()`를 사용하므로 다른 사용자와 CI에서도 실행할 수 있다. 이 작업의 증거를 남길 때는 `TMPDIR`을 지정된 보관 폴더 안의 ext4 경로로 설정한다. 테스트가 만든 폴더는 종료할 때 지운다.
