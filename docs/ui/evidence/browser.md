# 브라우저 확인 시도

- 일시: 2026-11-25 (Asia/Seoul).
- 대상: `prototype/uiux/Main.dc.html`; README 안내대로 `python3 -m http.server 18765 --bind 127.0.0.1 --directory prototype/uiux`로 정적 제공.
- 명령: `/home/keeproll/.orca/cli/bin/orca tab create --headless --url http://127.0.0.1:18765/Main.dc.html --json`
- 결과: `ok:false`, `desktop_browser_bridge_unavailable`.

```text
No Orca desktop is sharing its browser with this host. On your desktop, open this host's SSH settings and turn on "Allow this host to control Orca browser tabs in its workspaces", make sure Settings › Browser › SSH workspaces is "SSH host" and this host isn't listed under "Hosts browsing from this device instead", and keep the host connected. The desktop needs an Orca version that supports it.
```

위 시도에서는 저자가 탭/실제 렌더/클릭/인쇄 증거를 확보하지 못했다. 이 최초 실패를 독립 리뷰 성공으로 소급 변경하지 않는다. `probe.mjs`의 VM도 브라우저를 대신하지 않는다.

## 이후 제공된 독립 브라우저 리뷰

2026-11-25 Claude 리뷰(로컬 `~/.cache/agent-wbs-baseline/REVIEW.md`)는 Playwright+Chromium headless159.0.8154.6으로14화면/31탭/8모달/일반9상태와오류21종중19종을확인했다. 스크린샷·고정시각·폭별파일은 [대응표](../screenshots.md)에있으며이미지를커밋하지않았다. 저자는원본과제공JSON을대조했고죽은슬롯/인쇄오프셋/좁은WBS사진을직접열어확인했다.

미확인: net/e400 오류, CP승인뒤상태, Planning이견채택결과, 실제OS인쇄대화상자, 스크린리더. iframe PDF폰트는about:blank때문에유효한검증이아니었다. 독립리뷰의프로토타입확인으로제품 UAT를통과체크하지않는다.
