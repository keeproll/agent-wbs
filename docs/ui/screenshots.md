# 화면 ID별 독립 리뷰 스크린샷 대응표

> 처음 읽는다면 [README.md](README.md)의 화면 ID 읽는 법을 먼저 본다.

## 이 문서의 역할

이 문서는 독립 리뷰가 찍은 원본 프로토타입 스크린샷을 화면 ID별로 짝지어 둔 표다.

- 원본 자체를 비교하는 자료이고, 제품 구현 통과 증거가 아니다.
- 파일을 복사하거나 커밋하지 않았다. 표에는 파일 이름만 있다.

## 자료 위치

자료 루트는 **/home/keeproll/.cache/agent-wbs-baseline/**이다.

- 표의 파일명은 이 루트 기준이다.
- REVIEW.md·walk*.json·act*.json·resp.json 및 재현 mjs도 같은 폴더에 있다.
- 현재 로컬 파일이 있는 것은 확인했다.
- cache가 지워지면 표만으로 이미지를 복원할 수 없다. 그래서 coordinator가 원본 증거를 별도로 보관해야 한다.

## 자료 폴더 읽는 법

- **주시각 기준**: desktop-clock20261105/, **2026-11-05 20:00:00 Asia/Seoul**, 1920×1080.
  - 메뉴·탭·상태 비교는 이 자료를 우선한다.
- **보충**: desktop/, **2026-11-25 20:00:00 KST**, 모달·편집·오류·추가패널.
  - 날짜가 달라지면 실행시간/보고서 수/예상일이 달라진다. 그래서 주시각 자료와 같다고 비교하지 않는다.
- **폭 자료**: 각 폴더의 같은 ID 파일을 비교한다.
  - w1400/, w1280/, w1100/
  - tablet/(1024), tablet-portrait/(768), mobile/(390)
  - mobile-emulated/(기기390이지만 viewport meta 부재로 innerWidth980)
- 파일 이름 끝:
  - .png는 viewport(보이는 화면 영역)만 찍은 것이다.
  - .full.png는 전체 높이를 찍은 것이다.
- UI-13은 비정상 nav 주입으로만 열었다.
- UI-AUTH는 owner 추가 범위라 원본 스크린샷이 없다.
- 리뷰 환경: Playwright+Chromium headless159.0.8154.6, ko-KR/Asia·Seoul.
  - 로컬 정적 서버18799는 종료됐다.
  - 저자의 최초 Orca 브리지 실패와 독립 리뷰의 성공을 구분한다.

## 고정시각 재현 순서

왜 시계를 고정하나: 원본은 실제 시계로 보고서·예상일·경과시간을 계산한다. 시계를 고정해야 언제 찍어도 같은 화면이 나온다.

실행 환경은 리뷰가 이미 설치한 Playwright를 사용했다.
아래는 재현 순서 설명이며, 이 작업에서 새 브라우저를 실행한 기록은 아니다.
원본 파일은 수정하지 않는다.

1. prototype/uiux만 정적 서버로 제공한다.
2. 새 context에 viewport1920×1080, locale ko-KR, timezoneId Asia/Seoul을 설정한다.
3. 페이지 로드 전에 p.clock.install({time:new Date('2026-11-05T20:00:00+09:00')})을 실행한다.
4. Main.dc.html에 접속한 후 p.clock.runFor(3000)을 하고, document.fonts.ready를 기다린 후 해당 메뉴/탭/상태로 들어간다.
5. 각 상호작용 후 시계를 필요한 만큼만 진행시킨다. 보고서/예상일/경과시간에 사용한 시각을 사진과 함께 기록한다.

자세한 수행 코드는 자료 루트의 lib.mjs/walk.mjs/act*.mjs/resp.mjs다. 본문은 이 코드를 제품에 복사하라는 요구가 아니다.

## 대응표

- 각 파일은 가장 구체적인 화면 ID에만 배정했다.
- 상위 화면과 같은 사진을 모든 항목에 중복 배정해 커버리지를 부풀리지 않았다.
- 직접 사진이 없으면 "직접 파일 없음"으로 표시한다.

| 화면 ID | 주시각 11-05 파일 | 보충 11-25 파일 | 다른 폭·추가 증거 |
|---|---|---|---|
| UI-00 | 직접 파일 없음 | &#96;desktop/UI-00-collapsed.png&#96;<br>&#96;desktop/UI-00-offline.png&#96; | 직접 파일 없음 |
| UI-01 | &#96;desktop-clock20261105/UI-01-active.full.png&#96;<br>&#96;desktop-clock20261105/UI-01-active.png&#96;<br>&#96;desktop-clock20261105/UI-01-fresh.full.png&#96;<br>&#96;desktop-clock20261105/UI-01-fresh.png&#96;<br>&#96;desktop-clock20261105/UI-01.full.png&#96;<br>&#96;desktop-clock20261105/UI-01.png&#96; | &#96;desktop/UI-01-active.full.png&#96;<br>&#96;desktop/UI-01-active.png&#96;<br>&#96;desktop/UI-01-fresh.full.png&#96;<br>&#96;desktop/UI-01-fresh.png&#96;<br>&#96;desktop/UI-01.full.png&#96;<br>&#96;desktop/UI-01.png&#96; | &#96;mobile/UI-01.png&#96;<br>&#96;mobile-emulated/UI-01.png&#96;<br>&#96;tablet/UI-01.png&#96;<br>&#96;tablet-portrait/UI-01.png&#96;<br>&#96;w1100/UI-01.png&#96;<br>&#96;w1280/UI-01.png&#96;<br>&#96;w1400/UI-01.png&#96; |
| UI-02 | &#96;desktop-clock20261105/UI-02.full.png&#96;<br>&#96;desktop-clock20261105/UI-02.png&#96; | &#96;desktop/UI-02-edit.png&#96;<br>&#96;desktop/UI-02.full.png&#96;<br>&#96;desktop/UI-02.png&#96; | &#96;mobile/UI-02.png&#96;<br>&#96;mobile-emulated/UI-02.png&#96;<br>&#96;tablet/UI-02.png&#96;<br>&#96;tablet-portrait/UI-02.png&#96;<br>&#96;w1100/UI-02.png&#96;<br>&#96;w1280/UI-02.png&#96;<br>&#96;w1400/UI-02.png&#96; |
| UI-02A | &#96;desktop-clock20261105/UI-02A-cleanup.png&#96;<br>&#96;desktop-clock20261105/UI-02A-reg.full.png&#96;<br>&#96;desktop-clock20261105/UI-02A-reg.png&#96;<br>&#96;desktop-clock20261105/UI-02A.png&#96; | &#96;desktop/UI-02A-after-reset.png&#96;<br>&#96;desktop/UI-02A-cleanup.png&#96;<br>&#96;desktop/UI-02A-reg.full.png&#96;<br>&#96;desktop/UI-02A-reg.png&#96;<br>&#96;desktop/UI-02A.png&#96; | 직접 파일 없음 |
| UI-02B | &#96;desktop-clock20261105/UI-02B-fail.full.png&#96;<br>&#96;desktop-clock20261105/UI-02B-fail.png&#96;<br>&#96;desktop-clock20261105/UI-02B.full.png&#96;<br>&#96;desktop-clock20261105/UI-02B.png&#96; | &#96;desktop/UI-02B-fail.full.png&#96;<br>&#96;desktop/UI-02B-fail.png&#96;<br>&#96;desktop/UI-02B.full.png&#96;<br>&#96;desktop/UI-02B.png&#96; | 직접 파일 없음 |
| UI-02C | &#96;desktop-clock20261105/UI-02C.full.png&#96;<br>&#96;desktop-clock20261105/UI-02C.png&#96; | &#96;desktop/UI-02C.full.png&#96;<br>&#96;desktop/UI-02C.png&#96; | 직접 파일 없음 |
| UI-02D | &#96;desktop-clock20261105/UI-02D.full.png&#96;<br>&#96;desktop-clock20261105/UI-02D.png&#96; | &#96;desktop/UI-02D.full.png&#96;<br>&#96;desktop/UI-02D.png&#96; | 직접 파일 없음 |
| UI-02E | &#96;desktop-clock20261105/UI-02E-fail.full.png&#96;<br>&#96;desktop-clock20261105/UI-02E-fail.png&#96;<br>&#96;desktop-clock20261105/UI-02E.full.png&#96;<br>&#96;desktop-clock20261105/UI-02E.png&#96; | &#96;desktop/UI-02E-done.png&#96;<br>&#96;desktop/UI-02E-fail.full.png&#96;<br>&#96;desktop/UI-02E-fail.png&#96;<br>&#96;desktop/UI-02E.full.png&#96;<br>&#96;desktop/UI-02E.png&#96; | 직접 파일 없음 |
| UI-03 | &#96;desktop-clock20261105/UI-03-missing.full.png&#96;<br>&#96;desktop-clock20261105/UI-03-missing.png&#96;<br>&#96;desktop-clock20261105/UI-03.full.png&#96;<br>&#96;desktop-clock20261105/UI-03.png&#96; | &#96;desktop/UI-03-missing.full.png&#96;<br>&#96;desktop/UI-03-missing.png&#96;<br>&#96;desktop/UI-03.full.png&#96;<br>&#96;desktop/UI-03.png&#96; | &#96;mobile/UI-03.png&#96;<br>&#96;mobile-emulated/UI-03.png&#96;<br>&#96;tablet/UI-03.png&#96;<br>&#96;tablet-portrait/UI-03.png&#96;<br>&#96;w1100/UI-03.png&#96;<br>&#96;w1280/UI-03.png&#96;<br>&#96;w1400/UI-03.png&#96; |
| UI-03A | &#96;desktop-clock20261105/UI-03A.full.png&#96;<br>&#96;desktop-clock20261105/UI-03A.png&#96; | &#96;desktop/UI-03A.full.png&#96;<br>&#96;desktop/UI-03A.png&#96; | 직접 파일 없음 |
| UI-03B | &#96;desktop-clock20261105/UI-03B.full.png&#96;<br>&#96;desktop-clock20261105/UI-03B.png&#96; | &#96;desktop/UI-03B-empty.png&#96;<br>&#96;desktop/UI-03B.full.png&#96;<br>&#96;desktop/UI-03B.png&#96; | 직접 파일 없음 |
| UI-03C | &#96;desktop-clock20261105/UI-03C.full.png&#96;<br>&#96;desktop-clock20261105/UI-03C.png&#96; | &#96;desktop/UI-03C.full.png&#96;<br>&#96;desktop/UI-03C.png&#96; | &#96;mobile/UI-03C.png&#96;<br>&#96;mobile-emulated/UI-03C.png&#96;<br>&#96;tablet/UI-03C.png&#96;<br>&#96;tablet-portrait/UI-03C.png&#96;<br>&#96;w1100/UI-03C.png&#96;<br>&#96;w1280/UI-03C.png&#96;<br>&#96;w1400/UI-03C.png&#96; |
| UI-03D | &#96;desktop-clock20261105/UI-03D.full.png&#96;<br>&#96;desktop-clock20261105/UI-03D.png&#96; | &#96;desktop/UI-03D.full.png&#96;<br>&#96;desktop/UI-03D.png&#96; | 직접 파일 없음 |
| UI-03E | &#96;desktop-clock20261105/UI-03E.full.png&#96;<br>&#96;desktop-clock20261105/UI-03E.png&#96; | &#96;desktop/UI-03E-pass.png&#96;<br>&#96;desktop/UI-03E.full.png&#96;<br>&#96;desktop/UI-03E.png&#96; | 직접 파일 없음 |
| UI-03F | &#96;desktop-clock20261105/UI-03F.full.png&#96;<br>&#96;desktop-clock20261105/UI-03F.png&#96; | &#96;desktop/UI-03F.full.png&#96;<br>&#96;desktop/UI-03F.png&#96; | 직접 파일 없음 |
| UI-03-01 | &#96;desktop-clock20261105/UI-03-01.full.png&#96;<br>&#96;desktop-clock20261105/UI-03-01.png&#96; | &#96;desktop/UI-03-01-edit.png&#96;<br>&#96;desktop/UI-03-01.full.png&#96;<br>&#96;desktop/UI-03-01.png&#96; | &#96;mobile/UI-03-01.png&#96;<br>&#96;mobile-emulated/UI-03-01.png&#96;<br>&#96;tablet/UI-03-01.png&#96;<br>&#96;tablet-portrait/UI-03-01.png&#96;<br>&#96;w1100/UI-03-01.png&#96;<br>&#96;w1280/UI-03-01.png&#96;<br>&#96;w1400/UI-03-01.png&#96; |
| UI-03-01A | &#96;desktop-clock20261105/UI-03-01A.png&#96; | &#96;desktop/UI-03-01A-edit.png&#96;<br>&#96;desktop/UI-03-01A.png&#96; | 직접 파일 없음 |
| UI-03-01B | &#96;desktop-clock20261105/UI-03-01B.png&#96; | &#96;desktop/UI-03-01B.png&#96; | 직접 파일 없음 |
| UI-03-02 | &#96;desktop-clock20261105/UI-03-02.full.png&#96;<br>&#96;desktop-clock20261105/UI-03-02.png&#96; | &#96;desktop/UI-03-02.full.png&#96;<br>&#96;desktop/UI-03-02.png&#96; | 직접 파일 없음 |
| UI-03-03 | &#96;desktop-clock20261105/UI-03-03.full.png&#96;<br>&#96;desktop-clock20261105/UI-03-03.png&#96; | &#96;desktop/UI-03-03.full.png&#96;<br>&#96;desktop/UI-03-03.png&#96; | 직접 파일 없음 |
| UI-03-04 | &#96;desktop-clock20261105/UI-03-04.full.png&#96;<br>&#96;desktop-clock20261105/UI-03-04.png&#96; | &#96;desktop/UI-03-04.full.png&#96;<br>&#96;desktop/UI-03-04.png&#96; | 직접 파일 없음 |
| UI-03-05 | &#96;desktop-clock20261105/UI-03-05.full.png&#96;<br>&#96;desktop-clock20261105/UI-03-05.png&#96; | &#96;desktop/UI-03-05.full.png&#96;<br>&#96;desktop/UI-03-05.png&#96; | 직접 파일 없음 |
| UI-03-06 | &#96;desktop-clock20261105/UI-03-06.full.png&#96;<br>&#96;desktop-clock20261105/UI-03-06.png&#96; | &#96;desktop/UI-03-06.full.png&#96;<br>&#96;desktop/UI-03-06.png&#96; | 직접 파일 없음 |
| UI-03-07 | &#96;desktop-clock20261105/UI-03-07.full.png&#96;<br>&#96;desktop-clock20261105/UI-03-07.png&#96; | &#96;desktop/UI-03-07.full.png&#96;<br>&#96;desktop/UI-03-07.png&#96; | 직접 파일 없음 |
| UI-03-08 | &#96;desktop-clock20261105/UI-03-08.full.png&#96;<br>&#96;desktop-clock20261105/UI-03-08.png&#96; | &#96;desktop/UI-03-08.full.png&#96;<br>&#96;desktop/UI-03-08.png&#96; | 직접 파일 없음 |
| UI-03-09 | &#96;desktop-clock20261105/UI-03-09.full.png&#96;<br>&#96;desktop-clock20261105/UI-03-09.png&#96; | &#96;desktop/UI-03-09-compose.png&#96;<br>&#96;desktop/UI-03-09-sent.png&#96;<br>&#96;desktop/UI-03-09.full.png&#96;<br>&#96;desktop/UI-03-09.png&#96; | 직접 파일 없음 |
| UI-04 | &#96;desktop-clock20261105/UI-04.full.png&#96;<br>&#96;desktop-clock20261105/UI-04.png&#96; | &#96;desktop/UI-04.full.png&#96;<br>&#96;desktop/UI-04.png&#96; | &#96;mobile/UI-04.png&#96;<br>&#96;mobile-emulated/UI-04.png&#96;<br>&#96;tablet/UI-04.png&#96;<br>&#96;tablet-portrait/UI-04.png&#96;<br>&#96;w1100/UI-04.png&#96;<br>&#96;w1280/UI-04.png&#96;<br>&#96;w1400/UI-04.png&#96; |
| UI-04-01 | &#96;desktop-clock20261105/UI-04-01-fail.full.png&#96;<br>&#96;desktop-clock20261105/UI-04-01-fail.png&#96;<br>&#96;desktop-clock20261105/UI-04-01.full.png&#96;<br>&#96;desktop-clock20261105/UI-04-01.png&#96; | &#96;desktop/UI-04-01-fail.full.png&#96;<br>&#96;desktop/UI-04-01-fail.png&#96;<br>&#96;desktop/UI-04-01.full.png&#96;<br>&#96;desktop/UI-04-01.png&#96; | 직접 파일 없음 |
| UI-04-02 | &#96;desktop-clock20261105/UI-04-02.full.png&#96;<br>&#96;desktop-clock20261105/UI-04-02.png&#96; | &#96;desktop/UI-04-02.full.png&#96;<br>&#96;desktop/UI-04-02.png&#96; | 직접 파일 없음 |
| UI-04-03 | &#96;desktop-clock20261105/UI-04-03.full.png&#96;<br>&#96;desktop-clock20261105/UI-04-03.png&#96; | &#96;desktop/UI-04-03.full.png&#96;<br>&#96;desktop/UI-04-03.png&#96; | 직접 파일 없음 |
| UI-04-03A | &#96;desktop-clock20261105/UI-04-03A-Kafka.png&#96;<br>&#96;desktop-clock20261105/UI-04-03A-SSE.png&#96;<br>&#96;desktop-clock20261105/UI-04-03A-WebSocket.png&#96;<br>&#96;desktop-clock20261105/UI-04-03A.full.png&#96;<br>&#96;desktop-clock20261105/UI-04-03A.png&#96; | &#96;desktop/UI-04-03A-Kafka.png&#96;<br>&#96;desktop/UI-04-03A-SSE.png&#96;<br>&#96;desktop/UI-04-03A-WebSocket.png&#96;<br>&#96;desktop/UI-04-03A.full.png&#96;<br>&#96;desktop/UI-04-03A.png&#96; | 직접 파일 없음 |
| UI-04-04 | &#96;desktop-clock20261105/UI-04-04.png&#96; | &#96;desktop/UI-04-04.png&#96; | 직접 파일 없음 |
| UI-04-04A | &#96;desktop-clock20261105/UI-04-04A-neo4j.png&#96;<br>&#96;desktop-clock20261105/UI-04-04A-questdb.png&#96;<br>&#96;desktop-clock20261105/UI-04-04A-redis.png&#96;<br>&#96;desktop-clock20261105/UI-04-04A.png&#96; | &#96;desktop/UI-04-04A-neo4j.png&#96;<br>&#96;desktop/UI-04-04A-questdb.png&#96;<br>&#96;desktop/UI-04-04A-redis.png&#96;<br>&#96;desktop/UI-04-04A.png&#96; | 직접 파일 없음 |
| UI-04-05 | &#96;desktop-clock20261105/UI-04-05.png&#96; | &#96;desktop/UI-04-05.png&#96; | 직접 파일 없음 |
| UI-04-06 | &#96;desktop-clock20261105/UI-04-06.png&#96; | &#96;desktop/UI-04-06.png&#96; | 직접 파일 없음 |
| UI-05 | &#96;desktop-clock20261105/UI-05.full.png&#96;<br>&#96;desktop-clock20261105/UI-05.png&#96; | &#96;desktop/UI-05.full.png&#96;<br>&#96;desktop/UI-05.png&#96; | &#96;mobile/UI-05.png&#96;<br>&#96;mobile-emulated/UI-05.png&#96;<br>&#96;tablet/UI-05.png&#96;<br>&#96;tablet-portrait/UI-05.png&#96;<br>&#96;w1100/UI-05.png&#96;<br>&#96;w1280/UI-05.png&#96;<br>&#96;w1400/UI-05.png&#96; |
| UI-05-01 | &#96;desktop-clock20261105/UI-05-01.full.png&#96;<br>&#96;desktop-clock20261105/UI-05-01.png&#96; | &#96;desktop/UI-05-01.full.png&#96;<br>&#96;desktop/UI-05-01.png&#96; | 직접 파일 없음 |
| UI-05-02 | &#96;desktop-clock20261105/UI-05-02.png&#96; | &#96;desktop/UI-05-02.png&#96; | 직접 파일 없음 |
| UI-06 | &#96;desktop-clock20261105/UI-06-offline.png&#96;<br>&#96;desktop-clock20261105/UI-06.png&#96; | &#96;desktop/UI-06-offline.png&#96;<br>&#96;desktop/UI-06-subfail.png&#96;<br>&#96;desktop/UI-06.png&#96; | &#96;mobile/UI-06.png&#96;<br>&#96;mobile-emulated/UI-06.png&#96;<br>&#96;tablet/UI-06.png&#96;<br>&#96;tablet-portrait/UI-06.png&#96;<br>&#96;w1100/UI-06.png&#96;<br>&#96;w1280/UI-06.png&#96;<br>&#96;w1400/UI-06.png&#96; |
| UI-06A | 직접 파일 없음 | &#96;desktop/UI-06A.png&#96; | 직접 파일 없음 |
| UI-06B | 직접 파일 없음 | &#96;desktop/UI-06B.png&#96; | 직접 파일 없음 |
| UI-06C | 직접 파일 없음 | &#96;desktop/UI-06C.png&#96; | 직접 파일 없음 |
| UI-06D | 직접 파일 없음 | &#96;desktop/UI-06D.png&#96; | 직접 파일 없음 |
| UI-06E | 직접 파일 없음 | &#96;desktop/UI-06E.png&#96; | 직접 파일 없음 |
| UI-07 | &#96;desktop-clock20261105/UI-07.png&#96; | &#96;desktop/UI-07.png&#96; | &#96;mobile/UI-07.png&#96;<br>&#96;mobile-emulated/UI-07.png&#96;<br>&#96;tablet/UI-07.png&#96;<br>&#96;tablet-portrait/UI-07.png&#96;<br>&#96;w1100/UI-07.png&#96;<br>&#96;w1280/UI-07.png&#96;<br>&#96;w1400/UI-07.png&#96; |
| UI-07-01 | &#96;desktop-clock20261105/UI-07-01.png&#96; | &#96;desktop/UI-07-01.png&#96; | 직접 파일 없음 |
| UI-07-01A | 직접 파일 없음 | &#96;desktop/UI-07-01A.png&#96; | 직접 파일 없음 |
| UI-07-02 | &#96;desktop-clock20261105/UI-07-02.png&#96; | &#96;desktop/UI-07-02.png&#96; | 직접 파일 없음 |
| UI-07-03 | &#96;desktop-clock20261105/UI-07-03.png&#96; | &#96;desktop/UI-07-03.png&#96; | 직접 파일 없음 |
| UI-08 | &#96;desktop-clock20261105/UI-08.png&#96; | &#96;desktop/UI-08.png&#96; | &#96;mobile/UI-08.png&#96;<br>&#96;mobile-emulated/UI-08.png&#96;<br>&#96;tablet/UI-08.png&#96;<br>&#96;tablet-portrait/UI-08.png&#96;<br>&#96;w1100/UI-08.png&#96;<br>&#96;w1280/UI-08.png&#96;<br>&#96;w1400/UI-08.png&#96; |
| UI-08-01 | &#96;desktop-clock20261105/UI-08-01.png&#96; | &#96;desktop/UI-08-01.png&#96; | 직접 파일 없음 |
| UI-08-01A | &#96;desktop-clock20261105/UI-08-01A-fail.full.png&#96;<br>&#96;desktop-clock20261105/UI-08-01A-fail.png&#96;<br>&#96;desktop-clock20261105/UI-08-01A-guard.full.png&#96;<br>&#96;desktop-clock20261105/UI-08-01A-guard.png&#96;<br>&#96;desktop-clock20261105/UI-08-01A.full.png&#96;<br>&#96;desktop-clock20261105/UI-08-01A.png&#96; | &#96;desktop/UI-08-01A-fail.full.png&#96;<br>&#96;desktop/UI-08-01A-fail.png&#96;<br>&#96;desktop/UI-08-01A-guard.full.png&#96;<br>&#96;desktop/UI-08-01A-guard.png&#96;<br>&#96;desktop/UI-08-01A.full.png&#96;<br>&#96;desktop/UI-08-01A.png&#96; | 직접 파일 없음 |
| UI-08-02 | &#96;desktop-clock20261105/UI-08-02.png&#96; | &#96;desktop/UI-08-02.png&#96; | 직접 파일 없음 |
| UI-08-03 | &#96;desktop-clock20261105/UI-08-03-fail.png&#96;<br>&#96;desktop-clock20261105/UI-08-03.png&#96; | &#96;desktop/UI-08-03-fail.png&#96;<br>&#96;desktop/UI-08-03.png&#96; | 직접 파일 없음 |
| UI-08-04 | &#96;desktop-clock20261105/UI-08-04.full.png&#96;<br>&#96;desktop-clock20261105/UI-08-04.png&#96; | &#96;desktop/UI-08-04.full.png&#96;<br>&#96;desktop/UI-08-04.png&#96; | 직접 파일 없음 |
| UI-08-05 | &#96;desktop-clock20261105/UI-08-05.png&#96; | &#96;desktop/UI-08-05.png&#96; | 직접 파일 없음 |
| UI-09 | &#96;desktop-clock20261105/UI-09.png&#96; | &#96;desktop/UI-09.png&#96; | &#96;mobile/UI-09.png&#96;<br>&#96;mobile-emulated/UI-09.png&#96;<br>&#96;tablet/UI-09.png&#96;<br>&#96;tablet-portrait/UI-09.png&#96;<br>&#96;w1100/UI-09.png&#96;<br>&#96;w1280/UI-09.png&#96;<br>&#96;w1400/UI-09.png&#96; |
| UI-09A | &#96;desktop-clock20261105/UI-09A.png&#96; | &#96;desktop/UI-09A.png&#96; | 직접 파일 없음 |
| UI-10 | &#96;desktop-clock20261105/UI-10.full.png&#96;<br>&#96;desktop-clock20261105/UI-10.png&#96; | &#96;desktop/UI-10.full.png&#96;<br>&#96;desktop/UI-10.png&#96; | &#96;mobile/UI-10.png&#96;<br>&#96;mobile-emulated/UI-10.png&#96;<br>&#96;tablet/UI-10.png&#96;<br>&#96;tablet-portrait/UI-10.png&#96;<br>&#96;w1100/UI-10.png&#96;<br>&#96;w1280/UI-10.png&#96;<br>&#96;w1400/UI-10.png&#96; |
| UI-11 | &#96;desktop-clock20261105/UI-11.full.png&#96;<br>&#96;desktop-clock20261105/UI-11.png&#96; | &#96;desktop/UI-11-print.png&#96;<br>&#96;desktop/UI-11.full.png&#96;<br>&#96;desktop/UI-11.png&#96; | &#96;mobile/UI-11.png&#96;<br>&#96;mobile-emulated/UI-11.png&#96;<br>&#96;tablet/UI-11.png&#96;<br>&#96;tablet-portrait/UI-11.png&#96;<br>&#96;w1100/UI-11.png&#96;<br>&#96;w1280/UI-11.png&#96;<br>&#96;w1400/UI-11.png&#96; |
| UI-11A | 직접 파일 없음 | &#96;desktop/UI-11A-done.png&#96;<br>&#96;desktop/UI-11A.png&#96; | 직접 파일 없음 |
| UI-11B | 직접 파일 없음 | &#96;desktop/UI-11B.png&#96; | 직접 파일 없음 |
| UI-11C | 직접 파일 없음 | &#96;desktop/UI-11C.png&#96; | 직접 파일 없음 |
| UI-11D | 직접 파일 없음 | &#96;desktop/UI-11D-pdf-fail.png&#96; | 직접 파일 없음 |
| UI-12 | &#96;desktop-clock20261105/UI-12.full.png&#96;<br>&#96;desktop-clock20261105/UI-12.png&#96; | &#96;desktop/UI-12.full.png&#96;<br>&#96;desktop/UI-12.png&#96; | &#96;mobile/UI-12.png&#96;<br>&#96;mobile-emulated/UI-12.png&#96;<br>&#96;tablet/UI-12.png&#96;<br>&#96;tablet-portrait/UI-12.png&#96;<br>&#96;w1100/UI-12.png&#96;<br>&#96;w1280/UI-12.png&#96;<br>&#96;w1400/UI-12.png&#96; |
| UI-12-01 | &#96;desktop-clock20261105/UI-12-01.full.png&#96;<br>&#96;desktop-clock20261105/UI-12-01.png&#96; | &#96;desktop/UI-12-01.full.png&#96;<br>&#96;desktop/UI-12-01.png&#96; | 직접 파일 없음 |
| UI-12-01A | &#96;desktop-clock20261105/UI-12-01A-fail.full.png&#96;<br>&#96;desktop-clock20261105/UI-12-01A-fail.png&#96; | &#96;desktop/UI-12-01A-fail.full.png&#96;<br>&#96;desktop/UI-12-01A-fail.png&#96;<br>&#96;desktop/UI-12-01A-token.png&#96;<br>&#96;desktop/UI-12-01A.png&#96; | 직접 파일 없음 |
| UI-12-01B | &#96;desktop-clock20261105/UI-12-01B-fail.full.png&#96;<br>&#96;desktop-clock20261105/UI-12-01B-fail.png&#96; | &#96;desktop/UI-12-01B-fail.full.png&#96;<br>&#96;desktop/UI-12-01B-fail.png&#96;<br>&#96;desktop/UI-12-01B.png&#96; | 직접 파일 없음 |
| UI-12-01C | 직접 파일 없음 | &#96;desktop/UI-12-01C.png&#96; | &#96;UI-12-01C-dead-slot.png&#96; |
| UI-12-01D | 직접 파일 없음 | &#96;desktop/UI-12-01D.png&#96; | 직접 파일 없음 |
| UI-12-01E | &#96;desktop-clock20261105/UI-12-01E-cliver.full.png&#96;<br>&#96;desktop-clock20261105/UI-12-01E-cliver.png&#96;<br>&#96;desktop-clock20261105/UI-12-01E-obscut.full.png&#96;<br>&#96;desktop-clock20261105/UI-12-01E-obscut.png&#96; | &#96;desktop/UI-12-01E-cliver.full.png&#96;<br>&#96;desktop/UI-12-01E-cliver.png&#96;<br>&#96;desktop/UI-12-01E-obscut.full.png&#96;<br>&#96;desktop/UI-12-01E-obscut.png&#96;<br>&#96;desktop/UI-12-01E.png&#96; | 직접 파일 없음 |
| UI-12-02 | &#96;desktop-clock20261105/UI-12-02.full.png&#96;<br>&#96;desktop-clock20261105/UI-12-02.png&#96; | &#96;desktop/UI-12-02.full.png&#96;<br>&#96;desktop/UI-12-02.png&#96; | 직접 파일 없음 |
| UI-12-02A | 직접 파일 없음 | &#96;desktop/UI-12-02A.png&#96; | 직접 파일 없음 |
| UI-12-02B | 직접 파일 없음 | &#96;desktop/UI-12-02B.png&#96; | 직접 파일 없음 |
| UI-12-03 | &#96;desktop-clock20261105/UI-12-03.full.png&#96;<br>&#96;desktop-clock20261105/UI-12-03.png&#96; | &#96;desktop/UI-12-03.full.png&#96;<br>&#96;desktop/UI-12-03.png&#96; | 직접 파일 없음 |
| UI-12-03A | 직접 파일 없음 | &#96;desktop/UI-12-03A.png&#96; | 직접 파일 없음 |
| UI-12-03B | 직접 파일 없음 | &#96;desktop/UI-12-03B-error.png&#96;<br>&#96;desktop/UI-12-03B.png&#96; | 직접 파일 없음 |
| UI-12-03C | 직접 파일 없음 | &#96;desktop/UI-12-03C.png&#96; | 직접 파일 없음 |
| UI-12-04 | &#96;desktop-clock20261105/UI-12-04.full.png&#96;<br>&#96;desktop-clock20261105/UI-12-04.png&#96; | &#96;desktop/UI-12-04.full.png&#96;<br>&#96;desktop/UI-12-04.png&#96; | 직접 파일 없음 |
| UI-12-04A | 직접 파일 없음 | &#96;desktop/UI-12-04A-error.png&#96;<br>&#96;desktop/UI-12-04A.png&#96; | 직접 파일 없음 |
| UI-12-04B | 직접 파일 없음 | &#96;desktop/UI-12-04B-view.png&#96;<br>&#96;desktop/UI-12-04B.png&#96; | 직접 파일 없음 |
| UI-12-04C | &#96;desktop-clock20261105/UI-12-04C-fail.full.png&#96;<br>&#96;desktop-clock20261105/UI-12-04C-fail.png&#96; | &#96;desktop/UI-12-04C-fail.full.png&#96;<br>&#96;desktop/UI-12-04C-fail.png&#96;<br>&#96;desktop/UI-12-04C.png&#96; | 직접 파일 없음 |
| UI-12-05 | &#96;desktop-clock20261105/UI-12-05.full.png&#96;<br>&#96;desktop-clock20261105/UI-12-05.png&#96; | &#96;desktop/UI-12-05-view.png&#96;<br>&#96;desktop/UI-12-05.full.png&#96;<br>&#96;desktop/UI-12-05.png&#96; | 직접 파일 없음 |
| UI-12-05A | 직접 파일 없음 | &#96;desktop/UI-12-05A.png&#96; | 직접 파일 없음 |
| UI-12-05B | 직접 파일 없음 | &#96;desktop/UI-12-05B-preview.png&#96;<br>&#96;desktop/UI-12-05B.png&#96; | 직접 파일 없음 |
| UI-12-05C | 직접 파일 없음 | &#96;desktop/UI-12-05C.png&#96; | 직접 파일 없음 |
| UI-12-05D | &#96;desktop-clock20261105/UI-12-05D-fail.full.png&#96;<br>&#96;desktop-clock20261105/UI-12-05D-fail.png&#96; | &#96;desktop/UI-12-05D-fail.full.png&#96;<br>&#96;desktop/UI-12-05D-fail.png&#96;<br>&#96;desktop/UI-12-05D.png&#96; | 직접 파일 없음 |
| UI-12-06 | &#96;desktop-clock20261105/UI-12-06.full.png&#96;<br>&#96;desktop-clock20261105/UI-12-06.png&#96; | &#96;desktop/UI-12-06-checked.png&#96;<br>&#96;desktop/UI-12-06.full.png&#96;<br>&#96;desktop/UI-12-06.png&#96; | 직접 파일 없음 |
| UI-12-06A | 직접 파일 없음 | &#96;desktop/UI-12-06A.png&#96; | 직접 파일 없음 |
| UI-13 | 직접 파일 없음 | &#96;desktop/UI-13.png&#96; | 직접 파일 없음 |
| SYS-01 | &#96;desktop-clock20261105/SYS-01-error.png&#96;<br>&#96;desktop-clock20261105/SYS-01-loading.png&#96; | &#96;desktop/SYS-01-error.png&#96;<br>&#96;desktop/SYS-01-loading.png&#96; | 직접 파일 없음 |
| SYS-02 | 직접 파일 없음 | &#96;desktop/SYS-02.png&#96; | 직접 파일 없음 |
| SYS-03 | 직접 파일 없음 | &#96;desktop/SYS-03.png&#96; | 직접 파일 없음 |
| MOD-01 | 직접 파일 없음 | &#96;desktop/MOD-01.png&#96; | 직접 파일 없음 |
| MOD-02 | 직접 파일 없음 | &#96;desktop/MOD-02-list.png&#96;<br>&#96;desktop/MOD-02.png&#96; | 직접 파일 없음 |
| MOD-03 | 직접 파일 없음 | &#96;desktop/MOD-03.png&#96; | 직접 파일 없음 |
| MOD-04 | 직접 파일 없음 | &#96;desktop/MOD-04.png&#96; | 직접 파일 없음 |
| MOD-05 | 직접 파일 없음 | &#96;desktop/MOD-05.png&#96; | 직접 파일 없음 |
| MOD-06 | 직접 파일 없음 | &#96;desktop/MOD-06.png&#96; | 직접 파일 없음 |
| MOD-06A | 직접 파일 없음 | &#96;desktop/MOD-06A-errors.png&#96;<br>&#96;desktop/MOD-06A.png&#96; | &#96;mobile/MOD-06A.png&#96;<br>&#96;mobile-emulated/MOD-06A.png&#96;<br>&#96;tablet/MOD-06A.png&#96;<br>&#96;tablet-portrait/MOD-06A.png&#96;<br>&#96;w1100/MOD-06A.png&#96;<br>&#96;w1280/MOD-06A.png&#96;<br>&#96;w1400/MOD-06A.png&#96; |
| MOD-06B | 직접 파일 없음 | &#96;desktop/MOD-06B.png&#96; | 직접 파일 없음 |
| MOD-06C | 직접 파일 없음 | &#96;desktop/MOD-06C.png&#96; | 직접 파일 없음 |
| MOD-07 | 직접 파일 없음 | &#96;desktop/MOD-07-errors.png&#96;<br>&#96;desktop/MOD-07.png&#96; | 직접 파일 없음 |
| MOD-08 | 직접 파일 없음 | &#96;desktop/MOD-08.png&#96; | 직접 파일 없음 |
| UI-AUTH | 원본 없음(owner 추가 화면) | 원본 없음 | UAT-AUTH-01~03에서 제품 검증 |

## 별도 결함·인쇄 자료

화면 ID가 아니라 불일치(MM)나 인쇄 결함을 보여 주는 자료다.

- desktop/MM-03-browser.png
- desktop/MM-05-browser.png
- desktop/MM-06-browser.png
- desktop/MM-12-browser.png
- desktop/theme-dark-pref.png
- desktop/UI-11-print.pdf: Ctrl+P 전체 문서 인쇄 결함. desktop/UI-11-print.png와 대응한다.
- desktop/UI-11-print-iframe.pdf/html: PDF 버튼 iframe의 별도 경로다. about:blank 때문에 폰트 검증은 무효였다. 서버PDF 인수 근거로 쓰지 않는다.

## 확인 범위와 남은 확인

독립 리뷰가 확인한 것: 14화면·31탭·8모달·일반9상태·오류21종 중19종.

아직 확인하지 않은 것:

- net/e400(열지 않았다)
- CP 승인 뒤 상태
- Planning 이견 채택 결과
- 실OS 인쇄 대화상자
- 스크린리더
- iframe PDF 폰트 확인도 유효한 증거가 아니다.

이 개정 저자가 한 일:

- 제공된 JSON/원본을 대조했다.
- 죽은 슬롯 crop·Ctrl+P 사진·1024 WBS 사진을 직접 열어 확인했다.
- 모든 PNG를 새로 촬영하거나 클릭 전체를 독립 재실행했다고 주장하지 않는다.
