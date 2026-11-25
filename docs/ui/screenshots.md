# 화면 ID별 독립 리뷰 스크린샷 대응표

자료 루트는 **/home/keeproll/.cache/agent-wbs-baseline/**이다. 표의 파일명은 이 루트 기준이며 파일을 복사하거나 커밋하지 않았다. 원본 자체를 비교하는 자료이고 제품 구현 통과 증거가 아니다. REVIEW.md·walk*.json·act*.json·resp.json 및 재현 mjs도 같은 폴더에 있다. 현재 로컬 파일 존재를 확인했고 cache가 지워지면 표만으로 이미지를 복원할 수 없으므로 coordinator가 원본 증거를 별도 보관해야 한다.

- 주시각 기준: desktop-clock20261105/, **2026-11-05 20:00:00 Asia/Seoul**, 1920×1080. 메뉴·탭·상태비교는 이자료 우선.
- 보충: desktop/, **2026-11-25 20:00:00 KST**, 모달·편집·오류·추가패널. 날짜가달라지는 실행시간/보고서수/예상일을주시각자료와같다고비교하지않는다.
- 폭자료: w1400/, w1280/, w1100/, tablet/(1024), tablet-portrait/(768), mobile/(390), mobile-emulated/(기기390이지만 viewport meta부재로innerWidth980). 각폴더의같은ID파일을비교한다.
- .png는viewport, .full.png는전체높이이며 UI-13은비정상nav주입으로만열었다. UI-AUTH는owner추가범위라원본스크린샷없음.
- 리뷰환경: Playwright+Chromium headless159.0.8154.6, ko-KR/Asia·Seoul. 로컬정적서버18799는종료됨. 저자의최초Orca브리지실패와독립리뷰의성공을구분한다.

## 고정시각 재현 순서

실행환경은리뷰가이미설치한Playwright를사용했다. 아래는재현순서설명이며이작업에서새브라우저를실행한기록은아니다. 원본파일은수정하지않는다.

1. prototype/uiux만정적서버로제공.
2. 새context에viewport1920×1080, locale ko-KR, timezoneId Asia/Seoul 설정.
3. 페이지로드전에 p.clock.install({time:new Date('2026-11-05T20:00:00+09:00')}) 실행.
4. Main.dc.html 접속후 p.clock.runFor(3000), document.fonts.ready 대기후해당메뉴/탭/상태로진입.
5. 각상호작용후시계를필요한만큼만진행시키고보고서/예상일/경과시간에사용한시각을사진과함께기록.

자세한수행코드는자료루트lib.mjs/walk.mjs/act*.mjs/resp.mjs이며본문은이코드를제품에복사하라는요구가아니다.

## 대응표

각파일은가장구체적인화면ID에만배정했다. 상위화면과같은사진을전항목에중복배정해커버리지를부풀리지않았다. 직접사진이없으면없음으로표시한다.

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

- desktop/MM-03-browser.png
- desktop/MM-05-browser.png
- desktop/MM-06-browser.png
- desktop/MM-12-browser.png
- desktop/theme-dark-pref.png
- desktop/UI-11-print.pdf: Ctrl+P 전체문서인쇄 결함. desktop/UI-11-print.png와대응.
- desktop/UI-11-print-iframe.pdf/html: PDF버튼iframe별도경로; about:blank때문에폰트검증은무효였음. 서버PDF 인수근거로쓰지않음.

## 확인 범위와 남은 확인

독립리뷰는14화면·31탭·8모달·일반9상태·오류21종중19종을확인했다. net/e400은열지않았으며CP승인뒤상태·Planning이견채택결과·실OS인쇄대화상자·스크린리더는미확인이다. iframe PDF폰트확인도유효한증거가아니다. 이개정저자는제공JSON/원본을대조하고죽은슬롯crop·Ctrl+P사진·1024WBS사진을직접열어확인했다. 모든PNG를새로촬영하거나클릭전체를독립재실행했다고주장하지않는다.
