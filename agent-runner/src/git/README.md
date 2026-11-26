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
```

- `runnerHome`은 Runner 전용 절대 경로다. 저장소는 `repos/<projectId>`, 작업 폴더는 `worktrees/<projectId>`, 입력 사본은 `inputs/<projectId>` 아래에 놓인다.
- 작업 폴더인 **worktree**는 같은 저장소를 별도 브랜치로 꺼낸 폴더다. 예를 들어 두 Task가 각자 다른 폴더에서 개발하면 작업 중인 파일이 섞이지 않는다. 가이드에 따라 ext4 파일 시스템을 확인하고 Windows 드라이브 경로도 거부한다.
- 저장소는 **bare 저장소**, 즉 작업 파일 없이 Git 기록만 보관하는 형태로 복사한다. 따라서 초기화 때 저장소 루트의 파일을 직접 덮어쓸 일이 없다.
- **SHA**는 커밋의 고유 번호다. 커밋을 받는 메서드는 줄인 번호나 브랜치 이름 대신 전체 SHA만 허용한다. `head()`는 로컬 `main`, `fetch()`는 새로 확인한 원격 `main`의 SHA를 돌려준다.
- Runner를 다시 시작하면 `GitRepository.open(runnerHome, projectId)`로 연다. 입력 버전과 worktree 이름은 기존 상태 저장소에 기록한 이름을 재사용한다. 같은 이름을 만들면서 기존 폴더를 덮어쓰지는 않는다.

## 입력과 Task 검사

입력은 고정한 커밋의 `prototype/`만 Git 객체에서 읽는다. 파일 권한은 읽기 전용 `0444`, 폴더는 읽고 들어갈 수만 있는 `0555`다. 실행 파일도 실행하지 않는다. **심볼릭 링크(symlink)**는 다른 파일을 가리키는 지름길이므로 입력에 있으면 실패한다. **하위 모듈(submodule)**은 다른 저장소를 연결한 항목이므로 따라가지 않고 실패한다. 실패한 사본은 지운다.

**Git LFS**는 큰 파일을 Git 기록 밖에 보관하는 확장 도구다. LFS 포인터가 있으면 도구 설치를 확인하고 해당 커밋의 원본을 받아 크기와 해시를 검증한다. 도구나 원본이 없으면 포인터 파일만 복사해 성공했다고 하지 않는다. 일반 worktree를 만드는 과정에서는 저장소의 외부 변환 명령을 실행하지 않는다.

`checkTask(mainSha, taskHeadSha)`는 거부할 파일의 `{ path, reason }` 목록을 돌려준다. Task 검사 첫 단계에서 목록이 비었는지 확인해야 한다. 두 커밋의 공통 조상인 **merge-base**부터 비교하고, 이름 변경도 이전 경로와 새 경로를 모두 검사한다. `prototype/`, `.agentwbs/` 변경과 `.gitignore`에 해당하는 추적 파일을 거부한다. 작업자가 `.gitignore`를 지워 우회하지 못하도록 기준 커밋의 규칙도 적용한다.

읽기 전용 권한은 실수로 쓰는 것을 막는 장치다. 같은 운영체제 사용자 권한을 가진 Agent가 권한을 다시 바꾸는 것까지 막는 격리 장치는 아니므로, 실제 Agent 실행에는 계획된 CLI 권한 제한과 sandbox(허용한 폴더만 쓰게 하는 실행 환경)도 적용해야 한다.

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

브랜치는 전달받은 목록 중 `agent/`로 시작하는 이름만 삭제한다. `agent/*` 전체를 검색해서 전달하면 안 된다. 예를 들어 서버가 `agent/TASK-0001-h2`만 기록했다면 다른 사람이 만든 `agent/manual`은 그대로 둔다. 로컬 폴더 삭제도 전달받은 이름에 한정하며 관리 경로의 심볼릭 링크를 거부한다.

원격 쓰기는 M4-04 GitHub 어댑터의 책임이다. 외부 쓰기 권한을 확인한 뒤 열린 PR(병합 요청)을 닫고, 서버가 기록한 원격 Agent 브랜치만 삭제하고, `result.commit`을 일반 push로 전송한다. 이 모듈에는 push나 PR API가 없다. 이 함수만 끝났다고 전체 정리 완료나 프로세스 종료 증거를 보고하면 안 된다. 원격 `main`이 다시 움직여 push가 거절되면 `reset`을 재시도하여 최신 입력을 보존하는 커밋을 만든다.

## 검증

`pnpm -C agent-runner test -- git`은 실제 외부 저장소에 접속하지 않고 로컬 bare 저장소로 검증한다. 테스트 폴더와 실행 증거는 작업 지시에 따라 `/home/keeproll/.orca/bots/agentwbs/archive/2026-11-26/M4-03/` 아래를 사용한다. 테스트가 만든 폴더는 종료할 때 지운다.
