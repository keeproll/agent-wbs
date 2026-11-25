# 브라우저 확인 시도

- 일시: 2026-11-25 (Asia/Seoul).
- 대상: `prototype/uiux/Main.dc.html`; README 안내대로 `python3 -m http.server 18765 --bind 127.0.0.1 --directory prototype/uiux`로 정적 제공.
- 명령: `/home/keeproll/.orca/cli/bin/orca tab create --headless --url http://127.0.0.1:18765/Main.dc.html --json`
- 결과: `ok:false`, `desktop_browser_bridge_unavailable`.

```text
No Orca desktop is sharing its browser with this host. On your desktop, open this host's SSH settings and turn on "Allow this host to control Orca browser tabs in its workspaces", make sure Settings › Browser › SSH workspaces is "SSH host" and this host isn't listed under "Hosts browsing from this device instead", and keep the host connected. The desktop needs an Orca version that supports it.
```

탭 생성·스크린샷·실제 렌더·UI 클릭·인쇄 결과는 확보하지 못했다. 스크린샷 파일이 없는 이유이며 이를 UI 통과 증거로 간주하지 않는다. `probe.mjs`의 Node VM 검사는 원본 메모리 모델·일부 로직 검사일 뿐 브라우저를 대신하지 않는다. 원본의 React/vendor/support.js/woff2는 읽기 대상으로만 확인했으며 수정하지 않았다.
