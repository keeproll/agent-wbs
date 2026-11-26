# 브라우저 확인 시도

> 이 문서는 저자가 원본 프로토타입을 브라우저로 확인하려다 실패한 기록과, 이후 독립 리뷰가 확인한 범위를 적는다.

## 최초 시도

- 일시: 2026-11-25 (Asia/Seoul).
- 대상: `prototype/uiux/Main.dc.html`.
  - README 안내대로 `python3 -m http.server 18765 --bind 127.0.0.1 --directory prototype/uiux`로 정적 제공했다.
- 명령: `/home/keeproll/.orca/cli/bin/orca tab create --headless --url http://127.0.0.1:18765/Main.dc.html --json`
- 결과: `ok:false`, `desktop_browser_bridge_unavailable`.

```text
No Orca desktop is sharing its browser with this host. On your desktop, open this host's SSH settings and turn on "Allow this host to control Orca browser tabs in its workspaces", make sure Settings › Browser › SSH workspaces is "SSH host" and this host isn't listed under "Hosts browsing from this device instead", and keep the host connected. The desktop needs an Orca version that supports it.
```

위 오류는 "이 호스트와 브라우저를 공유하는 Orca 데스크톱이 없다"는 뜻이다.

- 위 시도에서는 저자가 탭/실제 렌더/클릭/인쇄 증거를 확보하지 못했다.
- 이 최초 실패를 독립 리뷰 성공으로 소급 변경하지 않는다. 누가 무엇을 확인했는지 정확히 남기기 위해서다.
- `probe.mjs`의 VM도 브라우저를 대신하지 않는다.

## 이후 제공된 독립 브라우저 리뷰

- 2026-11-25 Claude 리뷰(로컬 `~/.cache/agent-wbs-baseline/REVIEW.md`)가 확인했다.
- 도구: Playwright+Chromium headless159.0.8154.6.
- 확인 범위: 14화면/31탭/8모달/일반9상태와 오류21종 중19종.
- 스크린샷·고정시각·폭별 파일은 [대응표](../screenshots.md)에 있으며, 이미지를 커밋하지 않았다.
- 저자는 원본과 제공JSON을 대조했고, 죽은 슬롯/인쇄 오프셋/좁은 WBS 사진을 직접 열어 확인했다.

미확인:

- net/e400 오류
- CP 승인 뒤 상태
- Planning 이견 채택 결과
- 실제 OS 인쇄 대화상자
- 스크린리더

iframe PDF 폰트는 about:blank 때문에 유효한 검증이 아니었다.
독립 리뷰의 프로토타입 확인으로 제품 UAT를 통과 체크하지 않는다.
