# 디자인 값과 반응형 규칙

> 처음 읽는다면 [README.md](README.md)의 용어집을 먼저 본다. 디자인 용어는 아래 [용어 풀이](#디자인-용어-풀이)에 따로 모았다.

## 이 문서의 역할

이 문서는 원본 프로토타입의 색·글꼴·간격·반경·그림자·반응형 규칙 **값**을 모은 곳이다.
값은 원본 그대로이며 하나도 바꾸지 않았다.

- 원본은 별도 디자인 토큰 시스템이 아니다. CSS 변수·클래스·인라인 스타일·동적 문자열을 함께 사용한다.
- 없는 다크 테마나 임의 spacing scale(간격 단계표)을 보충하지 않았다.
  - 왜: 원본에 없는 규칙을 만들어 넣으면 "원본 값"과 "새로 정한 값"이 섞여 무엇이 기준인지 흐려진다.
- 전체 CSS·인라인 값·SVG는 뒤의 기계 추출 부록이 정본이다.
- 저자의 최초 브라우저 실행은 막혔지만, 독립 리뷰의 고정시각 스크린샷·실측을 받아 대조했다(screenshots.md).
- 원문 CSS 선언과 실제 인쇄·좁은 폭 결함을 구분한다. 선언이 맞아도 실제 화면은 다를 수 있기 때문이다.

## 디자인 용어 풀이

아래 설명은 이 문서를 읽기 위한 일반 용어 풀이다. 값과 규칙은 각 절의 원본 값이 기준이다.

| 용어 | 뜻 | 이 문서에서의 예 |
|---|---|---|
| 디자인 토큰 | 색·간격·크기 같은 디자인 값에 이름을 붙여 한곳에서 관리하는 방식. 보통 "원시 값(primitive) → 의미 이름(semantic) → 컴포넌트별 이름(component)" 세 층으로 나눈다. | 원본에는 이런 층 구조가 없고, `--ac`처럼 역할 이름이 붙은 CSS 변수 한 층만 있다. |
| CSS 변수 | `--이름: 값`으로 정의하고 `var(--이름)`으로 꺼내 쓰는 CSS 값 보관함. | `--bg`, `--ink` |
| hex 색 | `#` 뒤 16진수(보통 6자리)로 빨강·초록·파랑 양을 적은 색 표기. | `#2453CF` |
| rgba | 빨강·초록·파랑 값에 투명도(alpha, 0~1)를 더한 색 표기. | `rgba(17,20,26,.45)`는 45% 불투명한 어두운 색 |
| 표면 (surface) | 카드·패널처럼 배경 위에 올라오는 면의 색. | `--sf`, `--sf2` |
| 경계 (border, line) | 영역을 나누는 테두리 선의 색. | `--ln`, `--ln2` |
| 강조색 (accent) | 선택·링크·주요 버튼처럼 눈길을 끌어야 하는 곳의 색. | `--ac` |
| 상태색 | 성공·경고·오류를 뜻하는 색. 글자색과 옅은 배경색을 짝으로 쓴다. | `--ok`/`--okbg`, `--wn`/`--wnbg`, `--dg`/`--dgbg` |
| 간격 (spacing) | 요소 안쪽 여백(padding), 바깥 여백(margin), 요소 사이 간격(gap)을 통틀어 부르는 말. | `padding:20px 24px 0` |
| padding 값 읽는 법 | 값이 4개면 위·오른쪽·아래·왼쪽, 3개면 위·좌우·아래, 2개면 위아래·좌우 순서다. | `0 20px 0 12px` = 위0, 오른쪽20px, 아래0, 왼쪽12px |
| spacing scale | 간격을 4px·8px처럼 정해진 단계로만 쓰게 하는 규칙. 원본에는 없다. | — |
| 반경 (border-radius) | 모서리를 둥글게 깎는 정도. 값이 클수록 둥글다. 정사각형 요소에 `50%`를 주면 원이 된다(가로·세로가 다르면 타원). `999px`는 모서리를 아주 크게 둥글려 알약 모양을 만든다. | `6px`, `50%` |
| 그림자 (box-shadow) | 요소 아래에 그리는 그림자. `x y 흐림 색` 순서로 적는다. `inset`은 안쪽 그림자로, 원본에서는 선택 표시 막대처럼 쓴다. | `0 8px 24px rgba(0,0,0,.12)`, `inset 3px 0 0 var(--ac)` |
| z-index | 겹친 요소 중 무엇을 위에 그릴지 정하는 숫자. 클수록 위에 놓인다. | overlay `z-index:50` |
| overlay | 모달 뒤를 덮는 반투명 막. | `rgba(17,20,26,.45)` |
| 글꼴 굵기 (font-weight) | 글자 두께. 숫자가 클수록 굵다. 가변 글꼴은 범위 안의 어떤 굵기든 쓸 수 있다. | `45 920`, `15px/700` |
| `15px/700` 표기 | 이 문서에서 "글자 크기/굵기"를 짧게 적은 것. | 브랜드 `15px/700` |
| line-height | 줄 높이. 글자 크기에 곱하는 배수. | `1.5` |
| tabular-nums | 숫자 폭을 모두 같게 맞춰 표에서 자릿수가 세로로 줄 맞게 하는 설정. | body |
| font-display:swap | 웹 글꼴을 받는 동안 기본 글꼴로 먼저 보여 주고, 다 받으면 바꾸는 설정. | 14줄 |
| breakpoint (미디어 쿼리) | 화면 폭에 따라 다른 CSS를 적용하는 기준 폭. `max-width:1100px`는 "폭이 1100px 이하일 때". | 반응형 표 |
| vh | 브라우저 보이는 높이(viewport)의 1%. `100vh`는 화면 높이 전체. | 앱 `height:100vh` |
| `minmax(0,1fr)` | CSS grid에서 "남은 폭을 나눠 갖되 0보다 작아지지 않게"라는 뜻. `fr`은 남은 공간의 몫. | 2영역 레이아웃 |
| cascade | 같은 요소에 여러 CSS 규칙이 겹칠 때 어느 것이 이기는지 정하는 순서. | `.detail` 규칙 |
| prefers-reduced-motion | 운영체제에서 "움직임 줄이기"를 켠 사용자에게 적용하는 조건. | 반응형 표 |
| prefers-color-scheme | 운영체제의 밝은/어두운 테마 선호에 맞추는 조건. 원본에는 없다. | — |
| viewport meta | 휴대폰 브라우저가 화면 폭을 실제 기기 폭으로 계산하게 하는 HTML 설정. 없으면 휴대폰이 넓은 가상 폭(예: 980px)으로 그린다. | 본문 head에는 없음 |

## 색과 테마

출처: Main.dc.html 16줄 `:root`.
`:root`는 문서 전체에 적용되는 CSS 변수를 정의하는 곳이다.

| 변수 | 원본 값 | 역할 |
|---|---|---|
| --bg | #F4F5F7 | 페이지 배경 |
| --sf / --sf2 | #FFFFFF / #F8F9FB | 표면 / 보조 표면 |
| --ln / --ln2 | #E1E4E9 / #C9CED6 | 기본 / 진한 경계 |
| --ink / --ink2 / --ink3 | #16191E / #3E4651 / #5A6270 | 본문 / 보조 / 설명 |
| --ac / --acbg | #2453CF / #EAF0FD | 강조 / 선택 배경 |
| --dg / --dgbg | #B42318 / #FDEDEB | 오류 / 위험 배경 |
| --wn / --wnbg | #8F4700 / #FFF2E2 | 경고 / 경고 배경 |
| --ok / --okbg | #1B7339 / #E5F3E9 | 성공 / 성공 배경 |

변수 이름은 짧은 약어다: bg=background(배경), sf=surface(표면), ln=line(경계), ink=글자색, ac=accent(강조), dg=danger(위험), wn=warning(경고), ok=성공. 뒤의 `bg`는 그 상태의 옅은 배경색이다.

- 링크 기본 #2453CF, hover(마우스를 올렸을 때) #1A3F9E(23줄).
- 상태·Agent·진척·표·다이어그램에는 별도의 리터럴 색(변수 없이 직접 적은 색)도 있다. 그래서 변수만 옮기면 누락된다.
  - 예: Runner 정상 점 #1F8A46, offline 경계 #F1B8B2(38–40줄).
- 모든 개별 색은 CSS 부록에 포함했다.
- `prefers-color-scheme`, 테마 선택기, 다크 테마는 없다. 밝은 테마 한 벌이다.

## 글꼴과 숫자

- 14줄: `Pretendard GOV Variable`, weight `45 920`, normal, `font-display:swap`.
  - 글꼴을 찾는 순서: local(내 PC에 설치된 글꼴) → 번들 `assets/fdb4f16b4f38a76c99e473186cd3b353.woff2` → jsDelivr `pretendard-gov@1.3.9` 대체 소스.
- `--font:'Pretendard GOV Variable','Pretendard GOV',-apple-system,BlinkMacSystemFont,system-ui,'Apple SD Gothic Neo','Malgun Gothic',sans-serif`; `--mono:var(--font)`(16줄).
  - 앞의 글꼴이 없으면 다음 글꼴을 쓰는 대체 목록이다.
  - code/pre/kbd/samp/입력/placeholder까지 동일 계열을 쓴다(17–22줄). 즉 고정폭 글꼴을 따로 쓰지 않는다.
- body `13px`, `line-height:1.5`, `font-variant-numeric:tabular-nums`(18줄).
- 브랜드 `15px/700`, 로고 `11px/600`, 메타 설명 `11px`, Runner `12px/500` 등 실제 세부 크기는 CSS/인라인 부록에 원문 그대로 보존했다.
- 화면 전체가 12~14px 이상인 것은 아니다(10px·10.5px·11px도 있음).
- 메일은 예외다.
  - 글꼴: `'Pretendard GOV','Apple SD Gothic Neo','Malgun Gothic',sans-serif`.
  - 640px 표 레이아웃, 인라인 CSS(4005–4044줄). 웹 폰트 삽입 없음.
  - 왜 다른가: 메일 프로그램은 외부 CSS와 웹 글꼴을 잘 지원하지 않기 때문에 표와 인라인 스타일로 만든다.
- PDF는 원본 웹 CSS + A4/14mm(5000–5012줄).

## 레이아웃·간격·반경·그림자

| 대상 | 실제 값 | 출처 |
|---|---|---|
| 앱 | height:100vh; flex column; min-width:0 | 27 |
| 헤더 | 64px; gap:16px; padding:0 20px 0 12px | 28 |
| 좌측 메뉴 | 180px, 접힘 56px; padding:12px 8px; gap:2px | 49–50 |
| 메뉴 행 | height:38px; padding:0 10px; gap:9px; radius:6px | 51 |
| 페이지 | padding:20px 24px 0 | 58 |
| 로고 | 28×28px, radius:6px | 31 |
| Avatar | 28×28px, radius:50% | 43 |
| 아이콘 버튼 | 36×36px, radius:6px | 44 |
| Task 레일 | 260px; 상세는 남은 폭 | `.split.rail`, CSS 부록 |
| 2영역 / 3영역 | 260px minmax(0,1fr) / 260px minmax(0,1fr) 340px, gap:16px | 398–399 |
| 카드 | padding:16px; margin-bottom:16px; radius:8px | 410 |
| 기본 모달 / sm | width:min(1080px,100%) / min(480px,100%); max-height:calc(100vh - 48px); radius:10px | 346–347 |
| overlay | padding:24px; rgba(17,20,26,.45); z-index:50 | 345 |

표 읽는 법: "출처" 숫자는 원본 줄 번호다. `min(1080px,100%)`는 "1080px와 부모 영역의 사용 가능한 폭 중 작은 값"이다. 여기서 100%는 화면 폭이 아니라 모달을 담는 부모(overlay)의 폭이고, overlay에는 `padding:24px`가 있으므로 좌우 여백 24px씩을 뺀 폭이다. 예: 화면 폭이 800px이면 모달 최대 폭은 800−48=752px이다(원본 CSS로 계산한 값이며 브라우저 실측은 아니다).

반경:

- CSS의 반경 원문 고유값은 `0`, `2px`, `3px`, `4px`, `6px`, `8px`, `10px`, `16px`, `999px`, `50%`, `0 0 8px 8px`, `2px 2px 0 0`, `8px 8px 0 0`, `10px 10px 10px 2px`다.
- 값이 4개인 반경은 왼쪽 위부터 시계 방향(왼쪽 위·오른쪽 위·오른쪽 아래·왼쪽 아래)의 모서리별 값이다.

간격:

- 간격은 위치별 padding/gap/margin 원문을 따르며 공통 배수로 정규화하지 않는다.
- 인라인 스타일이 덮어쓰는 값까지 아래 부록에 보존했다.
- 가이드의 Modal 1024~1280px를 모든 모달에 일괄 적용하지 않는다. 원본은 모달마다 폭이 다르기 때문이다.

CSS의 `box-shadow` 고유값 전체:

```css
0 1px 1px rgba(0,0,0,.08)
0 20px 60px rgba(0,0,0,.25)
0 4px 14px rgba(0,0,0,.18)
0 8px 24px rgba(0,0,0,.12)
0 8px 24px rgba(0,0,0,.2)
inset -2px 0 0 #6232B8
inset 0 0 0 1px var(--ac)
inset 3px 0 0 #0A666B
inset 3px 0 0 #2453CF
inset 3px 0 0 var(--ac)
```

읽는 법: `0 8px 24px rgba(0,0,0,.12)`는 "가로 0, 아래로 8px, 24px만큼 흐리게, 12% 검정"이다. `inset 3px 0 0 …`는 흐림 없이 왼쪽 안쪽에 3px 막대를 그린다.

## 아이콘

- SVG `.ico`는 18×18px, fill:none(채우기 없음), stroke:currentColor(선 색은 글자색을 따름), stroke-width:1.7, round cap/join(선 끝과 꺾임을 둥글게).
- `.ico.sm`은 14×14px(46–47줄).
- `viewBox="0 0 24 24"`와 path 원문을 보존한다.
- NAV는 3063–3076줄의 12개 path다.
- 상태 점·캐럿·스피너·체크 및 문자 화살표도 원본 CSS/문구를 사용한다.
- 별도 아이콘 의존성(아이콘 패키지)은 없다.

## 반응형·인쇄·동작 줄이기

반응형은 화면 폭에 따라 배치를 바꾸는 규칙이다. 아래 조건은 위에서부터 폭이 좁아지는 순서다.

| 조건 | 원본 동작 | 줄 |
|---|---|---|
| max-width:1400px | `.detail` width:660px (뒤 rail 규칙과 실제 cascade도 함께 확인 필요) | 642 |
| max-width:1300px | `.pv-grid` 2열 | 570 |
| max-width:1280px | 대시보드·KPI 2열; `.three` 280px+나머지, 마지막 aside 다음행 | 639–640 |
| max-width:1200px | 보고서 `.rp-wrap` 1열 | 531 |
| max-width:1100px | 알림 규칙 1열; two/three/cmp 1열; side static | 241,641 |
| max-width:1100px | detail fixed top:64px, 좌우0, bottom0, z-index30; summary2열; kv110px+나머지; cols2/frow1열; choice2열; gate-r1fr auto | 643 |
| max-width:760px | nav60px, 메뉴문구/phase숨김; 프로젝트/헤더구분/phase/user숨김; page14px 12px 0; search100%; cmp-row1열 | 644 |
| prefers-reduced-motion:reduce | split 전환·skeleton 정지; topbar 고정; 버튼 스피너 2s로 감속(완전정지 아님) | 150,580,599 |
| print 선언 | body visibility:hidden, rpt-doc/자식 visible, 문서 absolute left:0/top:0/width:100%/패딩0; 부록 새페이지. 실제 기준점 결함은 아래 참조 | 532–538,552 |

- `meta viewport`는 메일 HTML에는 있고 본문 head에는 없다(1–9줄 vs 4029줄). 모바일 브라우저 실측이 필요하다.
- 데스크톱 1920×1080은 script preview 속성일 뿐, 고정 런타임 viewport가 아니다(2903줄).

## 독립 리뷰에서 확인한 인쇄·좁은 폭 결함

### 인쇄 기준점

- P532–538의 left/top:0 선언만으로 페이지 좌상단이라고 판정할 수 없다.
- P594의 .main position:relative 때문에 Ctrl+P 출력은 (180,64) 기준에서 시작하고, PDF 실측 폭은614px로 줄어든다(독립 리뷰 B3, desktop/UI-11-print.pdf·png).
  - 왜: `absolute`는 가장 가까운 `relative` 부모를 기준으로 위치를 잡기 때문이다.
- P5000 iframe 인쇄는 별도 경로다.
- 제품은 서버 PDF와 브라우저 인쇄 모두 출력가능영역 좌상단·열잘림없음으로 검증한다(MM-31, UAT-REPORT-05/06).

### 좁은 폭

- 독립 리뷰에서 1024px WBS 표는 내용1048px/가시794px로 오른쪽 열이 잘린다.
- 768px 문서는814px, 390px 도구막대는475px까지 넘친다.
- viewport meta 부재로 실제 모바일 에뮬레이션은980px로 렌더된다.
- 이는 원본 결함이며 복제 목표가 아니다.
- owner 추가 결정으로1280 이상 전체 지원, 그 아래 표 가로스크롤, 휴대폰 Task/CI/CP 상세 열람을 판정한다(UAT-RESP-01/02).

<!-- GENERATED: extract.py -->

## 원본 CSS 전체(값의 정본)

줄 번호는 `Main.dc.html`의 원본 줄 번호다. 원본에 토큰 이름이 없는 숫자를 임의의 spacing scale로 정규화하지 않았다.

```css
/* L14 */ @font-face{font-family:'Pretendard GOV Variable';font-weight:45 920;font-style:normal;font-display:swap;src:local('Pretendard GOV Variable'),url('./assets/fdb4f16b4f38a76c99e473186cd3b353.woff2') format('woff2-variations'),url('./assets/fdb4f16b4f38a76c99e473186cd3b353.woff2') format('woff2'),url('https://cdn.jsdelivr.net/npm/pretendard-gov@1.3.9/dist/web/variable/woff2/PretendardGOVVariable.woff2') format('woff2-variations'),url('https://cdn.jsdelivr.net/npm/pretendard-gov@1.3.9/dist/web/variable/woff2/PretendardGOVVariable.woff2') format('woff2')}
/* L15 */ /* Standalone Export 대비: 아티팩트 밖(파일 · 다른 호스트)에서는 /_blob 경로가 없으므로 jsDelivr(pretendard-gov 1.3.9 Variable)에서 내려받음. 설치된 폰트가 있으면 local() 우선 */
/* L16 */ :root{--bg:#F4F5F7;--sf:#FFFFFF;--sf2:#F8F9FB;--ln:#E1E4E9;--ln2:#C9CED6;--ink:#16191E;--ink2:#3E4651;--ink3:#5A6270;--ac:#2453CF;--acbg:#EAF0FD;--dg:#B42318;--dgbg:#FDEDEB;--wn:#8F4700;--wnbg:#FFF2E2;--ok:#1B7339;--okbg:#E5F3E9;--font:'Pretendard GOV Variable','Pretendard GOV',-apple-system,BlinkMacSystemFont,system-ui,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;--mono:var(--font)}
/* L17 */ html,body{font-family:var(--font)}
/* L18 */ body{margin:0;background:var(--bg);color:var(--ink);font-size:13px;line-height:1.5;font-variant-numeric:tabular-nums}
/* L19 */ *{box-sizing:border-box}
/* L20 */ button,input,select,textarea,option,optgroup{font:inherit;font-family:var(--font);color:inherit}
/* L21 */ input::placeholder,textarea::placeholder{font-family:var(--font)}
/* L22 */ code,pre,kbd,samp{font-family:var(--font)}
/* L23 */ a{color:#2453CF}a:hover{color:#1A3F9E}
/* L24 */ .mono{font-family:var(--mono)}
/* L25 */ .muted{color:var(--ink3)}
/* L26 */ .sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
/* L27 */ .app{height:100vh;display:flex;flex-direction:column;min-width:0}
/* L28 */ .hdr{height:64px;flex:none;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 20px 0 12px;background:var(--sf);border-bottom:1px solid var(--ln)}
/* L29 */ .hdr-l,.hdr-r{display:flex;align-items:center;gap:12px;min-width:0}
/* L30 */ .brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:15px;white-space:nowrap}
/* L31 */ .logo{width:28px;height:28px;border-radius:6px;background:var(--ink);color:#fff;display:grid;place-items:center;font-size:11px;font-family:var(--mono);font-weight:600}
/* L32 */ .hdr-sep{width:1px;height:24px;background:var(--ln)}
/* L33 */ .proj{display:flex;flex-direction:column;min-width:0;line-height:1.3}
/* L34 */ .proj-l{font-size:11px;color:var(--ink3)}
/* L35 */ .proj-n{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* L36 */ .phase-tag{font-size:12px;color:var(--ink3);border:1px dashed var(--ln2);border-radius:4px;padding:3px 8px;white-space:nowrap}
/* L37 */ .runner{display:flex;align-items:center;gap:8px;height:34px;padding:0 10px;border:1px solid var(--ln);border-radius:6px;background:var(--sf);cursor:pointer;font-size:12px;font-weight:500;white-space:nowrap}
/* L38 */ .runner .dot{width:8px;height:8px;border-radius:50%;background:#1F8A46}
/* L39 */ .runner.off{border-color:#F1B8B2;background:var(--dgbg);color:var(--dg)}
/* L40 */ .runner.off .dot{background:var(--dg)}
/* L41 */ .runner .mock{font-size:10px;font-family:var(--mono);color:var(--ink3);border:1px solid var(--ln2);border-radius:3px;padding:0 4px}
/* L42 */ .user{display:flex;align-items:center;gap:8px;font-weight:500;white-space:nowrap}
/* L43 */ .avatar{width:28px;height:28px;border-radius:50%;background:var(--acbg);color:var(--ac);display:grid;place-items:center;font-size:12px;font-weight:600}
/* L44 */ .iconbtn{width:36px;height:36px;display:grid;place-items:center;border:0;border-radius:6px;background:transparent;cursor:pointer;color:var(--ink2);flex:none}
/* L45 */ .iconbtn:hover{background:var(--bg)}
/* L46 */ .ico{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}
/* L47 */ .ico.sm{width:14px;height:14px}
/* L48 */ .body{flex:1;display:flex;min-height:0}
/* L49 */ .nav{width:180px;flex:none;background:var(--sf);border-right:1px solid var(--ln);padding:12px 8px;display:flex;flex-direction:column;gap:2px;overflow-y:auto}
/* L50 */ .nav.collapsed{width:56px}
/* L51 */ .nav-i{display:flex;align-items:center;gap:9px;height:38px;padding:0 10px;border:0;border-radius:6px;background:transparent;cursor:pointer;text-align:left;color:var(--ink2);font-weight:500;width:100%}
/* L52 */ .nav-i:hover{background:var(--bg)}
/* L53 */ .nav-i.on{background:var(--acbg);color:var(--ac);font-weight:600}
/* L54 */ .nav-l{flex:1;white-space:nowrap}
/* L55 */ .nav-ph{font-size:10.5px;color:var(--ink3);font-family:var(--mono);border:1px solid var(--ln);border-radius:3px;padding:0 4px}
/* L56 */ .nav-sep{height:1px;background:var(--ln);margin:8px 4px}
/* L57 */ .main{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
/* L58 */ .page{flex:1;display:flex;flex-direction:column;min-height:0;padding:20px 24px 0}
/* L59 */ .page-h{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:14px;flex-wrap:wrap}
/* L60 */ .page-h h1{margin:0;font-size:22px;font-weight:700;letter-spacing:-.01em}
/* L61 */ .page-sub{margin:2px 0 0;color:var(--ink3)}
/* L62 */ .btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;padding:0 14px;border:1px solid var(--ln2);border-radius:6px;background:var(--sf);cursor:pointer;font-weight:500;white-space:nowrap}
/* L63 */ .btn:hover{background:var(--sf2);border-color:#AEB5BF}
/* L64 */ .btn.primary{background:var(--ac);border-color:var(--ac);color:#fff}
/* L65 */ .btn.primary:hover{background:#1D46B3}
/* L66 */ .btn.danger{background:var(--dg);border-color:var(--dg);color:#fff}
/* L67 */ .btn.ghost{border-color:transparent;background:transparent;color:var(--ink2)}
/* L68 */ .btn.ghost:hover{background:var(--bg)}
/* L69 */ .btn.sm{height:30px;padding:0 10px;font-size:12px}
/* L70 */ .btn:disabled{opacity:.45;cursor:not-allowed}
/* L71 */ .toolbar{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px 10px;padding:12px;background:var(--sf);border:1px solid var(--ln);border-radius:8px 8px 0 0}
/* L72 */ .search{display:flex;align-items:center;gap:6px;height:34px;padding:0 10px;border:1px solid var(--ln2);border-radius:6px;background:var(--sf);width:250px;color:var(--ink3)}
/* L73 */ .search input{border:0;outline:0;flex:1;min-width:0;background:transparent;color:var(--ink)}
/* L74 */ .fsel{display:flex;flex-direction:column;gap:2px}
/* L75 */ .fsel-l{font-size:11px;color:var(--ink3);font-weight:500}
/* L76 */ .fsel select,.inp{height:34px;border:1px solid var(--ln2);border-radius:6px;background:var(--sf);padding:0 8px}
/* L77 */ .fsel select{min-width:100px}
/* L78 */ .fsel.on select{border-color:var(--ac);background:var(--acbg);color:#1A3F9E;font-weight:500}
/* L79 */ .tb-sp{flex:1}
/* L80 */ .tb-group{display:flex;gap:6px;align-items:flex-end;position:relative}
/* L81 */ .colmenu{position:absolute;right:0;top:40px;z-index:20;background:var(--sf);border:1px solid var(--ln2);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.12);padding:8px;width:210px}
/* L82 */ .colmenu label{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:4px;cursor:pointer}
/* L83 */ .colmenu label:hover{background:var(--bg)}
/* L84 */ .colmenu-n{font-size:11px;color:var(--ink3);padding:4px 8px 6px;border-bottom:1px solid var(--ln);margin-bottom:4px}
/* L85 */ .resbar{display:flex;align-items:center;gap:12px;padding:6px 12px;background:var(--sf2);border-left:1px solid var(--ln);border-right:1px solid var(--ln);border-bottom:1px solid var(--ln);font-size:12px;color:var(--ink3)}
/* L86 */ .split{flex:1;display:flex;min-height:0;gap:16px;padding-bottom:16px}
/* L87 */ .list{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0}
/* L88 */ .tbl{flex:1;overflow-x:hidden;overflow-y:auto;background:var(--sf);border:1px solid var(--ln);border-top:0;border-radius:0 0 8px 8px}
/* L89 */ .trow{display:grid;align-items:center;border-bottom:1px solid var(--ln)}
/* L90 */ .thead .th{white-space:nowrap}.gtr.h .gc{overflow-wrap:normal;word-break:keep-all}
/* L91 */ .thead{position:sticky;top:0;z-index:2;background:var(--sf2);font-size:12px;font-weight:600;color:var(--ink2)}
/* L92 */ .th,.td{padding:8px 8px;min-width:0;word-break:keep-all;overflow-wrap:anywhere}
/* L93 */ .th{white-space:normal !important;line-height:1.3}
/* L94 */ .cell2{display:flex;flex-direction:column;align-items:flex-start;gap:4px}
/* L95 */ .td .st{white-space:normal}.td .dm{white-space:nowrap}
/* L96 */ .g-days{overflow:hidden}
/* L97 */ .th{white-space:nowrap}
/* L98 */ .task{cursor:pointer;min-height:52px;background:var(--sf)}
/* L99 */ .task:hover{background:#F6F8FC}
/* L100 */ .task.sel{background:var(--acbg);box-shadow:inset 3px 0 0 var(--ac)}
/* L101 */ .grp{background:var(--sf2);min-height:40px}
/* L102 */ .grp.ph{background:#EDEFF3}
/* L103 */ .grp-t{display:flex;align-items:center;gap:8px;min-width:0}
/* L104 */ .grp-k{font-size:10.5px;font-family:var(--mono);color:var(--ink3);text-transform:uppercase;letter-spacing:.04em}
/* L105 */ .grp-n{font-weight:700}
/* L106 */ .grp.wp .grp-n{font-weight:600}
/* L107 */ .grp-agg{font-size:12px;color:var(--ink3);margin-left:6px}
/* L108 */ .caret{width:26px;height:26px;display:grid;place-items:center;border:0;border-radius:4px;background:transparent;cursor:pointer;color:var(--ink2);flex:none}
/* L109 */ .caret:hover{background:#DDE1E7}
/* L110 */ .caret svg{transition:transform .12s}
/* L111 */ .caret.open svg{transform:rotate(90deg)}
/* L112 */ .wbsno{font-size:12px;color:var(--ink2)}
/* L113 */ .tcell{display:flex;flex-direction:column;align-items:flex-start;gap:1px}
/* L114 */ .tlink{border:0;background:none;padding:0;text-align:left;font-weight:600;color:var(--ink);cursor:pointer;font-size:13.5px;line-height:1.35}
/* L115 */ .tlink:hover{color:var(--ac);text-decoration:underline}
/* L116 */ .tid{font-size:11.5px;color:var(--ink3)}
/* L117 */ .wt{display:inline-block;padding:1px 8px;border:1px solid var(--ln2);border-radius:4px;font-size:12px;color:var(--ink2);background:var(--sf);white-space:nowrap}
/* L118 */ .dm{display:inline-block;padding:1px 6px;border-radius:4px;background:#2B3340;color:#fff;font-size:11.5px;font-weight:500;font-family:var(--mono)}
/* L119 */ .dm-rel{font-size:11.5px;color:var(--ink3);margin-left:4px;font-family:var(--mono)}
/* L120 */ .st{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
/* L121 */ .st-d{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
/* L122 */ .s-plan{color:#4E5763;background:#ECEEF1}.s-appr{color:#6232B8;background:#F1EBFB}.s-ready{color:#285682;background:#E6EFF8}.s-run{color:#1C4FBF;background:#E5EDFC}.s-qa{color:#0A666B;background:#E0F2F2}.s-rework{color:#994400;background:#FDEDDC}.s-verif{color:#3443A3;background:#E9EBFA}.s-done{color:#1B7339;background:#E4F3E8}.s-fail{color:#B42318;background:#FCE9E7}
/* L123 */ .vf{display:inline-block;font-family:var(--mono);font-size:11.5px;font-weight:600;padding:1px 6px;border-radius:4px;border:1px solid;white-space:nowrap}
/* L124 */ .v-none{color:var(--ink3);border-color:var(--ln2);background:var(--sf)}.v-run{color:#3443A3;border-color:#B9C0EC;background:#F1F2FC}.v-pass{color:var(--ok);border-color:#A9D5B6;background:var(--okbg)}.v-fail{color:var(--dg);border-color:#F0B4AD;background:var(--dgbg)}.v-blk{color:var(--wn);border-color:#EBC08F;background:var(--wnbg)}
/* L125 */ .pri{font-size:12px;font-weight:600;white-space:nowrap}
/* L126 */ .p0{color:var(--dg)}.p1{color:var(--wn)}.p2{color:var(--ink2);font-weight:500}.p3{color:var(--ink3);font-weight:500}
/* L127 */ .blk{display:inline-flex;align-items:center;gap:4px;color:var(--dg);font-weight:600;font-size:12px;white-space:nowrap}
/* L128 */ .okt{display:inline-flex;align-items:center;gap:4px;color:var(--ok);font-weight:500;font-size:12px;white-space:nowrap}
/* L129 */ .agent{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-weight:500}
/* L130 */ .ag-mk{width:18px;height:18px;border-radius:4px;display:grid;place-items:center;font-size:10px;font-weight:700;font-family:var(--mono);color:#fff;background:#59616D}
/* L131 */ .ag-claude{background:#A8532F}.ag-codex{background:#1F2937}
/* L132 */ .cl{display:flex;flex-direction:column;gap:3px}
/* L133 */ .cl-n{font-family:var(--mono);font-size:12px}
/* L134 */ .bar{display:block;height:4px;border-radius:2px;background:#E3E6EB;overflow:hidden;width:64px}
/* L135 */ .bar.wide{width:100%}
/* L136 */ .bar-f{display:block;height:100%;background:var(--ac)}
/* L137 */ .bar.full .bar-f{background:var(--ok)}
/* L138 */ .upd{font-size:12px;color:var(--ink3);white-space:nowrap}
/* L139 */ .empty-st{padding:48px 24px;text-align:center;color:var(--ink3)}
/* L140 */ .detail{width:820px;flex:none;background:var(--sf);border:1px solid var(--ln);border-radius:8px;display:flex;flex-direction:column;min-height:0;overflow:hidden}
/* L141 */ .split.full .list,.split.rail .list{display:none}
/* L142 */ .split.full .detail,.split.rail .detail{width:auto;flex:1}
/* L143 */ .split > .wrail{display:none;width:260px;flex:none;min-height:0;overflow:auto}
/* L144 */ .split.rail > .wrail{display:flex;animation:railIn .24s ease-out}
/* L145 */ .split.rail .detail{animation:dtIn .24s ease-out}
/* L146 */ .split.exp .list{animation:listOut .24s ease-out}
/* L147 */ @keyframes railIn{from{width:100%}to{width:260px}}
/* L148 */ @keyframes dtIn{from{opacity:0;transform:translateX(32px)}to{opacity:1;transform:none}}
/* L149 */ @keyframes listOut{from{max-width:260px}to{max-width:100%}}
/* L150 */ @media (prefers-reduced-motion: reduce){.split.rail .wrail,.split.rail .detail,.split.exp .list{animation:none}}
/* L151 */ .rail-exp{flex:none}
/* L152 */ .wr-search{margin:0 0 6px;width:100%}.wr-search input{width:100%}
/* L153 */ .wr-f{margin:0 4px 6px}
/* L154 */ .wr-wp{font-size:11.5px;font-weight:600;color:var(--ink3);padding:8px 8px 2px;border-top:1px solid var(--ln);margin-top:4px}
/* L155 */ .rail-h{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:2px 2px 6px;flex:none}
/* L156 */ .rail-ttl{font-size:13px;font-weight:700;color:var(--ink)}
/* L157 */ .rail-tg{width:28px;height:28px;border:1px solid var(--ln);border-radius:6px;background:var(--sf);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:none;color:var(--ink2)}
/* L158 */ .rail-tg:hover{background:var(--bg)}
/* L159 */ .ds-layer{display:grid;grid-template-columns:84px minmax(0,1fr);gap:10px;align-items:start;padding:8px 0;border-top:1px solid var(--ln)}
/* L160 */ .ds-layer:first-of-type{border-top:0}
/* L161 */ .ds-lay-l{font-size:12px;font-weight:700;color:var(--ink3);padding-top:8px}
/* L162 */ .ds-comps{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px}
/* L163 */ .ds-comp{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border:1px solid var(--ln);border-radius:8px;background:var(--sf)}
/* L164 */ .ds-comp.pend{border-style:dashed;border-color:#C9A227;background:#FFFBEB}
/* L165 */ .ds-comp.off{opacity:.5;text-decoration:line-through}
/* L166 */ .gtr.lkrow{grid-template-columns:minmax(120px,1fr) minmax(120px,1fr) minmax(120px,1fr) minmax(160px,1.3fr);min-width:0}
/* L167 */ .gtr.cfrow{grid-template-columns:minmax(200px,1.6fr) minmax(110px,.8fr) minmax(160px,1.4fr) minmax(120px,1fr) 90px;min-width:0}
/* L168 */ .gtr.owrow{grid-template-columns:minmax(150px,1.1fr) minmax(110px,.8fr) minmax(140px,1fr) minmax(180px,1.4fr) 90px;min-width:0}
/* L169 */ .gtr.dsrow{grid-template-columns:120px minmax(200px,1.5fr) minmax(200px,2fr) 120px 96px;min-width:0;cursor:pointer}
/* L170 */ .gtr.dsrow.h{cursor:default}
/* L171 */ .gtr.dsrow:not(.h):hover{background:var(--bg)}
/* L172 */ .gtr.colrow{grid-template-columns:minmax(120px,1fr) minmax(110px,.9fr) minmax(110px,.9fr) minmax(120px,1fr) minmax(140px,1.4fr);min-width:0}
/* L173 */ .gtr .gc{overflow-wrap:anywhere}
/* L174 */ .ds-name{word-break:break-all}
/* L175 */ .ds-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 8px}.ds-bar .search{margin-left:auto;min-width:220px}
/* L176 */ .ds-h4{margin:12px 0 6px;font-size:13px}
/* L177 */ .ds-ul{margin:0 0 8px;padding-left:18px;font-size:13px}
/* L178 */ .ds-chips{display:flex;gap:6px;flex-wrap:wrap}
/* L179 */ .ds-link{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:0 0 12px;padding:8px 10px;border:1px solid var(--ln);border-radius:8px;background:var(--bg)}
/* L180 */ .dec-row{padding:10px 0;border-top:1px solid var(--ln)}.dec-row:first-of-type{border-top:0}
/* L181 */ .dec-row.off{opacity:.55}
/* L182 */ .dec-h{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
/* L183 */ .dec-c{font-weight:700;color:var(--ac,#2453CF)}
/* L184 */ .dec-p{margin:4px 0 0;font-size:13px;line-height:1.55}
/* L185 */ .dec-p .muted{display:inline-block;min-width:52px}
/* L186 */ .dec-f{display:flex;gap:6px;align-items:center;margin-top:6px}
/* L187 */ .tech-row{display:grid;grid-template-columns:minmax(140px,1fr) auto auto;gap:6px;align-items:center}.tech-row .inp{width:100%;min-width:0}.tech-row > .btn{order:3}.tr-c{order:4;grid-column:1/-1;min-width:0}.tr-c:empty{display:none}
/* L188 */ .gtr.cirow{grid-template-columns:84px 110px 70px 92px minmax(170px,1.3fr) 50px 148px minmax(120px,1fr);min-width:0;cursor:pointer}.gtr.cirow.h{cursor:default}.gtr.cirow:not(.h):hover{background:var(--bg)}
/* L189 */ .in-pend{margin:0 0 12px;padding:12px;border:1px solid #E9C46A;border-radius:8px;background:#FFFBEB}
/* L190 */ .vf-nav{display:flex;align-items:center;gap:6px;margin:0 0 10px;padding-bottom:10px;border-bottom:1px solid var(--ln)}
/* L191 */ .dt-head{padding:14px 20px 0;border-bottom:1px solid var(--ln);flex:none}
/* L192 */ .dt-top{display:flex;justify-content:space-between;align-items:center;gap:12px;min-height:32px}
/* L193 */ .dt-crumbs{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}
/* L194 */ .idchip{padding:1px 6px;border:1px solid var(--ln2);border-radius:4px;font-weight:600;color:var(--ink);font-size:12px}
/* L195 */ .dt-acts{display:flex;gap:4px;align-items:center}
/* L196 */ .dt-title{margin:6px 0 12px;font-size:19px;font-weight:700;letter-spacing:-.01em;line-height:1.35}
/* L197 */ .summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:1px;background:var(--ln);border:1px solid var(--ln);border-radius:6px;overflow:hidden}
/* L198 */ .sum-i{background:var(--sf);padding:8px 12px;display:flex;flex-direction:column;gap:4px;min-width:0}
/* L199 */ .sum-l{font-size:11px;color:var(--ink3);font-weight:500}
/* L200 */ .sum-v{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-weight:500;min-height:22px}
/* L201 */ .gatebtn{display:inline-flex;align-items:center;gap:6px;border:1px solid;border-radius:4px;padding:1px 8px;cursor:pointer;font-size:12px;font-weight:600;font-family:var(--mono)}
/* L202 */ .gatebtn.pass{color:var(--ok);border-color:#A9D5B6;background:var(--okbg)}
/* L203 */ .gatebtn.fail{color:var(--dg);border-color:#F0B4AD;background:var(--dgbg)}
/* L204 */ .banner{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:6px;font-size:12.5px;margin-top:10px;line-height:1.55}
/* L205 */ .banner.danger{background:var(--dgbg);color:#8A1C12}
/* L206 */ .banner.ok{background:var(--okbg);color:#155C2D}
/* L207 */ .banner.warn{background:var(--wnbg);color:#7A3D00}
/* L208 */ .banner.info{background:#EEF2F8;color:#2D3A4D}
/* L209 */ .banner .ico{margin-top:2px}
/* L210 */ .banner-b{flex:1;min-width:0}
/* L211 */ .banner b{font-weight:700}
/* L212 */ .reflink{border:0;background:none;padding:0;color:inherit;font-family:var(--mono);font-weight:600;text-decoration:underline;cursor:pointer;font-size:12px}
/* L213 */ .gate{margin-top:10px;border:1px solid var(--ln);border-radius:6px;overflow:hidden}
/* L214 */ .gate-r{display:grid;grid-template-columns:200px 84px minmax(0,1fr);gap:12px;align-items:center;padding:7px 12px;border-bottom:1px solid var(--ln);font-size:12.5px}
/* L215 */ .gate-f{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 12px;background:var(--sf2)}
/* L216 */ .tabs{display:flex;gap:2px;margin-top:12px;overflow-x:auto}
/* L217 */ .tab{height:40px;padding:0 12px;border:0;background:none;cursor:pointer;font-weight:500;color:var(--ink3);border-bottom:2px solid transparent;white-space:nowrap;display:flex;align-items:center;gap:6px}
/* L218 */ .tab:hover{color:var(--ink)}
/* L219 */ .tab.on{color:var(--ink);border-bottom-color:var(--ac);font-weight:600}
/* L220 */ .tab-c{font-size:11px;font-family:var(--mono);padding:0 5px;border-radius:8px;background:#ECEEF1;color:var(--ink2)}
/* L221 */ .tab-c.alert{background:var(--dgbg);color:var(--dg)}
/* L222 */ .stabs{display:flex;flex:none;min-height:41px;gap:2px;margin:4px 0 6px;overflow-x:auto;overflow-y:hidden;border-bottom:1px solid var(--ln)}
/* L223 */ .stabs .tab{margin-bottom:-1px}
/* L224 */ .gtr.orow{grid-template-columns:minmax(120px,1fr) 84px 48px minmax(150px,1.3fr) 84px minmax(150px,1fr);min-width:0}
/* L225 */ .gtr.crow{grid-template-columns:110px 148px 150px 84px minmax(220px,2fr);min-width:0}
/* L226 */ .gtr.orow .gc,.gtr.crow .gc{white-space:normal}
/* L227 */ .gtr.mrow{grid-template-columns:minmax(150px,1.4fr) 76px 76px 140px 70px minmax(140px,1fr) 76px 290px;min-width:0}
/* L228 */ .gtr.mrow .seg{flex-wrap:nowrap}.gtr.mrow .seg button{padding:0 9px}
/* L229 */ .gtr.mrow .gc{white-space:nowrap}.gtr.mrow .gc .tcell{white-space:normal}
/* L230 */ .gtr.lrow{grid-template-columns:148px 124px minmax(150px,1fr) 150px 64px minmax(160px,1.3fr) 170px;min-width:0}
/* L231 */ .gtr.off{background:var(--sf2)}.gtr.off .gc{color:var(--ink3)}
/* L232 */ .tg-sim{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 12px}
/* L233 */ .tg-rules{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
/* L234 */ .tg-rule{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--ln);border-radius:6px;cursor:pointer}.tg-rule .chk{margin-top:2px}
/* L235 */ .tg-chat{background:#E6EBEE;border-radius:8px;padding:14px;margin:8px 0 0}
/* L236 */ .tg-bubble{white-space:pre-wrap;word-break:break-word;background:#fff;border-radius:10px 10px 10px 2px;padding:10px 12px;max-width:560px;font-size:13px;line-height:1.6;box-shadow:0 1px 1px rgba(0,0,0,.08)}
/* L237 */ .gtr.tgrow{grid-template-columns:148px minmax(90px,.8fr) minmax(150px,1.4fr) 108px minmax(130px,1fr) 128px 44px minmax(130px,1fr) 64px;min-width:0;cursor:pointer}.gtr.tgrow.h{cursor:default}.gtr.tgrow:not(.h):hover{background:var(--bg)}
/* L238 */ .tg-det{border:1px solid var(--ln);border-radius:8px;padding:12px;margin:10px 0 0}
/* L239 */ .tg-cand{display:flex;gap:10px;align-items:center;padding:9px 12px;border:1px solid var(--ln);border-radius:6px;cursor:pointer;margin:0 0 6px}.tg-cand.on{border-color:var(--ac);background:var(--acbg)}
/* L240 */ .tg-steps{margin:0 0 12px;padding-left:20px;line-height:1.7}
/* L241 */ @media (max-width:1100px){.tg-rules{grid-template-columns:minmax(0,1fr)}}
/* L242 */ .mail-fr{width:100%;height:min(62vh,640px);border:1px solid var(--ln);border-radius:6px;background:#F2F4F7}
/* L243 */ .empty-box{padding:14px;border:1px dashed var(--ln2);border-radius:6px;background:var(--sf2)}
/* L244 */ .rp-sent{margin:0 0 10px;font-size:12.5px;color:var(--ink2)}.rp-sent summary{cursor:pointer}
/* L245 */ .dt-body{flex:1;overflow-y:auto;padding:20px}
/* L246 */ .pane{max-width:1160px}
/* L247 */ .pane-h{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap}
/* L248 */ .pane-h h3{margin:0;font-size:15px}
/* L249 */ .pane-hl{display:flex;align-items:baseline;gap:10px}
/* L250 */ h4{margin:0 0 6px;font-size:13px;font-weight:600}
/* L251 */ .sec{padding:14px 0;border-top:1px solid var(--ln)}
/* L252 */ .sec p{margin:0;color:var(--ink2);max-width:86ch}
/* L253 */ .empty{color:var(--ink3);font-style:italic}
/* L254 */ .kv{display:grid;grid-template-columns:148px minmax(0,1fr) 148px minmax(0,1fr);gap:8px 16px;margin:0 0 14px}
/* L255 */ .kv-l{color:var(--ink3);font-size:12px;padding-top:1px}
/* L256 */ .kv-v{font-weight:500;display:flex;gap:6px;align-items:center;flex-wrap:wrap;min-width:0}
/* L257 */ .cols2{display:grid;grid-template-columns:1fr 1fr;gap:24px}
/* L258 */ .lst{margin:0;padding-left:18px;color:var(--ink2)}
/* L259 */ .lst li{margin:3px 0}
/* L260 */ .lst.none{list-style:none;padding-left:0}
/* L261 */ code{font-family:var(--mono);font-size:12px;background:#F0F2F5;border:1px solid #E3E6EA;border-radius:3px;padding:0 4px;color:#1E2A3A;overflow-wrap:anywhere}
/* L262 */ pre.code{margin:4px 0;background:#151A22;color:#E6EAF0;border-radius:6px;padding:12px 14px;overflow:auto;font-family:var(--mono);font-size:12px;line-height:1.6;white-space:pre}
/* L263 */ pre.code code{background:none;border:0;padding:0;color:inherit}
/* L264 */ .mono-list li{font-family:var(--mono);font-size:12px}
/* L265 */ .chips{display:flex;gap:6px;flex-wrap:wrap}
/* L266 */ .chipref{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--ln2);border-radius:4px;padding:2px 8px;background:var(--sf);cursor:pointer;font-size:12px}
/* L267 */ .chipref:hover{border-color:var(--ac);color:var(--ac)}
/* L268 */ .deliv{font-size:11px;font-weight:600;padding:0 6px;border-radius:3px}
/* L269 */ .deliv.y{color:var(--ok);background:var(--okbg)}.deliv.n{color:var(--wn);background:var(--wnbg)}
/* L270 */ .sgrp{border:1px solid var(--ln);border-radius:8px;margin-bottom:14px;overflow:hidden}
/* L271 */ .sgrp-h{display:flex;align-items:baseline;gap:10px;padding:8px 14px;background:var(--sf2);border-bottom:1px solid var(--ln)}
/* L272 */ .sgrp-k{font-weight:700;font-size:12.5px}
/* L273 */ .g-do{color:#1C4FBF}.g-io{color:#0A666B}.g-con{color:#8F4700}.g-not{color:#B42318}.g-done{color:#1B7339}.g-ref{color:#3E4651}
/* L274 */ .ssec{padding:12px 14px;border-bottom:1px solid var(--ln)}
/* L275 */ .ssec:last-child{border-bottom:0}
/* L276 */ .ssec-h{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px}
/* L277 */ .ssec-h h4{margin:0}
/* L278 */ .ac-id{font-family:var(--mono);font-size:11.5px;font-weight:600;color:var(--ok);margin-right:6px}
/* L279 */ textarea.inp{height:auto;padding:8px 10px;width:100%;line-height:1.55;resize:vertical}
/* L280 */ .mono-in{font-family:var(--mono);font-size:12px}
/* L281 */ .edit-acts{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:6px}
/* L282 */ .gtb{border:1px solid var(--ln);border-radius:6px;overflow-x:auto;margin-bottom:16px}
/* L283 */ .gtr{display:grid;align-items:center;border-bottom:1px solid var(--ln);min-width:640px}
/* L284 */ .gtr:last-child{border-bottom:0}
/* L285 */ .gtr.h{background:var(--sf2);font-size:12px;font-weight:600;color:var(--ink2)}
/* L286 */ .gtr.dim{background:#FAFBFC}
/* L287 */ .gc{padding:8px 10px;min-width:0;overflow-wrap:anywhere;font-size:12.5px}
/* L288 */ .gt-wrap{overflow-x:auto;border:1px solid var(--ln);border-radius:6px}
/* L289 */ .gt{display:grid;min-width:100%}
/* L290 */ .gth{padding:7px 10px;background:var(--sf2);font-size:12px;font-weight:600;color:var(--ink2);border-bottom:1px solid var(--ln);white-space:nowrap}
/* L291 */ .gtd{padding:7px 10px;border-bottom:1px solid var(--ln);font-size:12.5px;min-width:0}
/* L292 */ .gtd.m{font-family:var(--mono);font-size:12px}
/* L293 */ .gtd.b{font-family:var(--mono);font-size:12px;font-weight:600;color:var(--ink)}
/* L294 */ .tsec{margin-bottom:18px}
/* L295 */ .tsec-h{display:flex;align-items:center;gap:8px;margin-bottom:6px}
/* L296 */ .tsec-h h4{margin:0}
/* L297 */ .tag{font-size:11px;font-weight:600;padding:1px 6px;border-radius:3px;background:#ECEEF1;color:var(--ink2)}
/* L298 */ .tag.new{background:var(--okbg);color:var(--ok)}
/* L299 */ .addbox{border:1px solid var(--ln2);border-radius:8px;padding:12px;background:var(--sf2);margin-bottom:16px}
/* L300 */ .addbox-r{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
/* L301 */ .cand{display:flex;flex-direction:column;gap:2px;max-height:260px;overflow-y:auto;border:1px solid var(--ln);border-radius:6px;background:var(--sf)}
/* L302 */ .cand button{display:grid;grid-template-columns:70px 86px minmax(0,1fr) auto;gap:10px;align-items:center;padding:7px 10px;border:0;border-bottom:1px solid var(--ln);background:none;text-align:left;cursor:pointer}
/* L303 */ .cand button:hover{background:var(--acbg)}
/* L304 */ .seg{display:inline-flex;flex-wrap:wrap;gap:4px}
/* L305 */ .seg button{height:30px;padding:0 10px;white-space:nowrap;flex:none;border:1px solid var(--ln2);border-radius:6px;background:var(--sf);cursor:pointer;font-size:12px}
/* L306 */ .seg button[aria-pressed="true"]{background:var(--ink);border-color:var(--ink);color:#fff}
/* L307 */ .chk{width:16px;height:16px;accent-color:#2453CF;cursor:pointer}
/* L308 */ .att{border:1px solid var(--ln);border-radius:8px;padding:12px 14px;margin-bottom:10px}
/* L309 */ .att-h{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px}
/* L310 */ .att-n{font-weight:700}
/* L311 */ .att p{margin:4px 0;color:var(--ink2)}
/* L312 */ .ev{display:grid;grid-template-columns:110px minmax(0,1fr);gap:6px 12px;margin-top:8px;font-size:12.5px}
/* L313 */ .ev-l{color:var(--ink3)}
/* L314 */ .msg{border:1px solid var(--ln);border-radius:8px;padding:12px 14px;margin-bottom:10px;background:var(--sf)}
/* L315 */ .msg.in{background:#F6F8FA;border-color:#D7DCE3}
/* L316 */ .msg.new{box-shadow:inset 3px 0 0 #0A666B}
/* L317 */ .msg-h{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:12px;margin-bottom:6px}
/* L318 */ .msg-who{font-weight:700;font-size:12.5px}
/* L319 */ .mtype{padding:0 6px;border:1px solid var(--ln2);border-radius:4px;background:var(--sf)}
/* L320 */ .dl{font-family:var(--mono);font-size:11px;font-weight:600;padding:1px 6px;border-radius:4px;white-space:nowrap}
/* L321 */ .d-q{color:var(--wn);background:var(--wnbg)}.d-s{color:#1C4FBF;background:#E5EDFC}.d-a{color:var(--ok);background:var(--okbg)}.d-f{color:var(--dg);background:var(--dgbg)}.d-c{color:var(--ink3);background:#ECEEF1}.d-r{color:#0A666B;background:#E0F2F2}
/* L322 */ .ws{font-size:11.5px;color:var(--ink2);border-left:1px solid var(--ln2);padding-left:8px}
/* L323 */ .newtag{font-size:10.5px;font-weight:700;color:#fff;background:#0A666B;border-radius:3px;padding:0 5px}
/* L324 */ .msg-b p{margin:2px 0;color:var(--ink2)}
/* L325 */ .msg-b.clip{max-height:92px;overflow:hidden;-webkit-mask-image:linear-gradient(#000 55%,transparent);mask-image:linear-gradient(#000 55%,transparent)}
/* L326 */ .msg-acts{display:flex;gap:4px;flex-wrap:wrap;margin-top:8px}
/* L327 */ .rp-sent .gtr .gc{word-break:keep-all;overflow-wrap:break-word}
/* L328 */ .al-row{display:grid;grid-template-columns:132px minmax(0,1fr) auto auto;gap:4px 8px;align-items:center;margin:4px 0 0}.al-row .al-t{min-width:0}
/* L329 */ .tag,.vf{justify-self:start;text-align:center}
/* L330 */ .compose{border:1px solid var(--ln2);border-radius:8px;padding:14px;background:var(--sf2);margin-top:16px}
/* L331 */ .cmp-row{display:grid;grid-template-columns:110px minmax(0,1fr);gap:12px;align-items:center;margin-bottom:8px}
/* L332 */ .cmp-acts{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:8px}
/* L333 */ .form{display:flex;flex-direction:column;gap:12px;max-width:900px}
/* L334 */ .frow{display:grid;grid-template-columns:150px minmax(0,1fr);gap:16px;align-items:start}
/* L335 */ .flabel{padding-top:7px;font-weight:500;font-size:12.5px;color:var(--ink2)}
/* L336 */ .req{font-size:10.5px;color:var(--dg);font-weight:600;margin-left:4px}
/* L337 */ .opt{font-size:10.5px;color:var(--ink3);margin-left:4px;font-weight:400}
/* L338 */ .fctl{display:flex;flex-direction:column;gap:4px;min-width:0}
/* L339 */ .fctl .inp{width:100%}
/* L340 */ .fctl select.inp{max-width:320px}
/* L341 */ .fhint{font-size:11.5px;color:var(--ink3)}
/* L342 */ .ferr{font-size:12px;color:var(--dg);font-weight:500}
/* L343 */ .inp.bad{border-color:var(--dg)}
/* L344 */ .form-acts{display:flex;justify-content:flex-end;gap:8px;padding-top:12px;border-top:1px solid var(--ln)}
/* L345 */ .overlay{position:fixed;inset:0;background:rgba(17,20,26,.45);display:grid;place-items:center;z-index:50;padding:24px}
/* L346 */ .modal{width:min(1080px,100%);max-height:calc(100vh - 48px);background:var(--sf);border-radius:10px;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.25)}
/* L347 */ .modal.sm{width:min(480px,100%)}
/* L348 */ .modal-h{display:flex;justify-content:space-between;align-items:center;padding:14px 24px;border-bottom:1px solid var(--ln)}
/* L349 */ .modal-h h2{margin:0;font-size:17px}
/* L350 */ .steps{display:flex;flex-wrap:wrap;margin:0;padding:12px 24px;list-style:none;border-bottom:1px solid var(--ln);background:var(--sf2);gap:4px 28px}
/* L351 */ .steps li{display:flex;align-items:center;gap:8px;color:var(--ink3);font-weight:500}
/* L352 */ .st-n{width:22px;height:22px;border-radius:50%;border:1px solid var(--ln2);display:grid;place-items:center;font-size:11px;font-family:var(--mono);background:var(--sf)}
/* L353 */ .steps li.cur{color:var(--ink);font-weight:600}
/* L354 */ .steps li.cur .st-n{background:var(--ac);color:#fff;border-color:var(--ac)}
/* L355 */ .steps li.done .st-n{background:var(--okbg);color:var(--ok);border-color:#A9D5B6}
/* L356 */ .modal-b{padding:20px 24px;overflow-y:auto;flex:1}
/* L357 */ .modal-b p{margin:0 0 8px;color:var(--ink2)}
/* L358 */ .modal-f{display:flex;align-items:center;gap:8px;padding:12px 24px;border-top:1px solid var(--ln)}
/* L359 */ .modal-f .sp{flex:1}
/* L360 */ .choice{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
/* L361 */ .choice button{display:flex;flex-direction:column;align-items:flex-start;padding:7px 10px;border:1px solid var(--ln2);border-radius:6px;background:var(--sf);cursor:pointer;text-align:left}
/* L362 */ .choice button[aria-pressed="true"]{border-color:var(--ac);background:var(--acbg);box-shadow:inset 0 0 0 1px var(--ac)}
/* L363 */ .choice .en{font-size:11px;color:var(--ink3);font-family:var(--mono)}
/* L364 */ .predpick{border:1px solid var(--ln);border-radius:6px;max-height:330px;overflow-y:auto}
/* L365 */ .predpick label{display:grid;grid-template-columns:20px 56px 84px minmax(0,1fr) auto;gap:10px;align-items:center;padding:7px 10px;border-bottom:1px solid var(--ln);cursor:pointer}
/* L366 */ .predpick label:hover{background:var(--sf2)}
/* L367 */ .notice{position:fixed;right:24px;bottom:24px;z-index:60;background:#1E2530;color:#fff;padding:10px 14px;border-radius:8px;font-size:12.5px;display:flex;gap:8px;align-items:center;box-shadow:0 8px 24px rgba(0,0,0,.2);max-width:460px}
/* L368 */ .ph-page{padding:32px 24px;max-width:880px}
/* L369 */ .ph-page h1{margin:0 0 4px;font-size:22px}
/* L370 */ .ph-box{margin-top:18px;border:1px dashed var(--ln2);border-radius:8px;padding:18px 20px;background:var(--sf)}
/* L371 */ .ph-box ul{margin:10px 0 16px;padding-left:18px;color:var(--ink2)}
/* L372 */ .dsec{border:1px solid var(--ln);border-radius:8px;margin-bottom:16px;overflow:hidden}
/* L373 */ .dsec-h{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 14px;background:var(--sf2);border-bottom:1px solid var(--ln);flex-wrap:wrap}
/* L374 */ .dsec-h h3{margin:0;font-size:14px}
/* L375 */ .dsec-b{padding:14px}
/* L376 */ .dent{border:1px solid var(--ln);border-radius:6px;padding:12px 14px;margin-bottom:12px}
/* L377 */ .dent-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
/* L378 */ .dent-n{font-weight:700;font-size:13.5px}
/* L379 */ .sp{flex:1}
/* L380 */ .rblk{margin-top:12px}
/* L381 */ .tsec-h .fhint{margin-left:4px}
/* L382 */ .mth{font-family:var(--mono);font-size:11px;font-weight:700;padding:1px 7px;border-radius:3px;color:#fff;background:#59616D}
/* L383 */ .m-get{background:#1B6B40}.m-post{background:#2453CF}.m-put,.m-patch{background:#8F4700}.m-delete{background:#B42318}
/* L384 */ .tag.del{background:var(--dgbg);color:var(--dg)}
/* L385 */ .tag.chg{background:var(--wnbg);color:var(--wn)}
/* L386 */ .secadd{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:10px 12px;border:1px dashed var(--ln2);border-radius:8px;margin-bottom:16px}
/* L387 */ .btn.rec{border-color:var(--ac);color:var(--ac);background:var(--acbg)}
/* L388 */ .edp-h{position:sticky;top:-20px;z-index:3;background:var(--sf);padding:4px 0 10px;border-bottom:1px solid var(--ln)}
/* L389 */ .edp-h h3{margin:0;font-size:16px}
/* L390 */ .edblk{margin-top:18px}
/* L391 */ .gtr.ed{min-width:max-content}
/* L392 */ .gtr.ed .gc{padding:5px 6px}
/* L393 */ .gtr.bad{background:#FFF6F5}
/* L394 */ .cellin{width:100%;height:30px;padding:0 6px;font-size:12.5px}
/* L395 */ .chk.bad{outline:2px solid var(--dg);outline-offset:1px}
/* L396 */ .iconbtn.sm{width:30px;height:30px}
/* L397 */ .page.scroll{overflow-y:auto}
/* L398 */ .two{display:grid;grid-template-columns:260px minmax(0,1fr);gap:16px;align-items:start;padding-bottom:24px}
/* L399 */ .three{flex:1;display:grid;grid-template-columns:260px minmax(0,1fr) 340px;gap:16px;min-height:0;padding-bottom:16px}
/* L400 */ .scrollc{overflow-y:auto;min-height:0}
/* L401 */ .mainc{min-width:0}
/* L402 */ .side{background:var(--sf);border:1px solid var(--ln);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:2px}
/* L403 */ .two .side{position:sticky;top:0}
/* L404 */ .side-i{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:8px 10px;border:0;border-radius:6px;background:none;text-align:left;cursor:pointer;width:100%;font-size:12.5px}
/* L405 */ .side-i:hover{background:var(--bg)}
/* L406 */ .side-i.on{background:var(--acbg);box-shadow:inset 3px 0 0 var(--ac)}
/* L407 */ .side-t{font-weight:600;font-size:13px;color:var(--ink)}
/* L408 */ .side-r{display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%}
/* L409 */ .side-h{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 4px 6px}
/* L410 */ .card{background:var(--sf);border:1px solid var(--ln);border-radius:8px;padding:16px;margin-bottom:16px}
/* L411 */ .h2{margin:2px 0;font-size:18px}
/* L412 */ .flow{list-style:none;display:flex;flex-wrap:wrap;gap:6px;margin:14px 0 0;padding:0}
/* L413 */ .flow li{display:flex;align-items:center;gap:8px;padding:5px 10px 5px 6px;border:1px solid var(--ln);border-radius:6px;color:var(--ink3);font-size:12.5px;background:var(--sf2)}
/* L414 */ .flow li.done{color:var(--ok);background:var(--okbg);border-color:#A9D5B6}
/* L415 */ .flow li.done .st-n{border-color:#A9D5B6}
/* L416 */ .flow li.cur{color:#fff;background:var(--ac);border-color:var(--ac);font-weight:600}
/* L417 */ .flow li.cur .st-n{background:#fff;color:var(--ac);border-color:#fff}
/* L418 */ .flow li.fail{color:var(--dg);background:var(--dgbg);border-color:#F0B4AD}
/* L419 */ .flow li.skip{color:var(--ink3);background:var(--sf);border-style:dashed;text-decoration:line-through}
/* L420 */ .cmp{display:grid;grid-template-columns:1fr 1fr;gap:12px}
/* L421 */ .cmp .card{margin-bottom:0}
/* L422 */ .sh{font-size:14px;margin:20px 0 10px;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
/* L423 */ .sh .muted{font-weight:400;font-size:12px}
/* L424 */ .rv{border:1px solid var(--ln);border-radius:8px;padding:12px 14px;margin-bottom:10px;background:var(--sf)}
/* L425 */ .rv.open{border-color:#EBC08F;background:#FFFCF7}
/* L426 */ .rv-h{display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap}
/* L427 */ .rv-opt{border:1px solid var(--ln);border-radius:6px;padding:8px 10px;background:var(--sf2)}
/* L428 */ .rv-opt.pick{border-color:#9CB4EE;background:var(--acbg)}
/* L429 */ .rv-opt.drop{opacity:.55}
/* L430 */ .rv-a{font-size:11px;font-weight:700;color:var(--ink3)}
/* L431 */ .rv-opt p{margin:2px 0 0;color:var(--ink2)}
/* L432 */ .rv-act{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px}
/* L433 */ .rv-act .inp{flex:1;min-width:220px}
/* L434 */ .rv-ops{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px;font-size:12px}
/* L435 */ .opchip{font-family:var(--mono);font-size:11.5px;background:#ECEEF1;border-radius:4px;padding:1px 6px}
/* L436 */ .kb{font-size:11px;font-weight:700;padding:1px 7px;border-radius:3px;white-space:nowrap}
/* L437 */ .k-agree,.k-add{color:var(--ok);background:var(--okbg)}
/* L438 */ .k-diff,.k-mod{color:var(--wn);background:var(--wnbg)}
/* L439 */ .k-rem{color:var(--dg);background:var(--dgbg)}
/* L440 */ .k-dep{color:#1C4FBF;background:#E5EDFC}
/* L441 */ .dbef{color:var(--ink3);text-decoration:line-through;text-decoration-color:#C9CED6}
/* L442 */ .daft{font-weight:500}
/* L443 */ .cps{font-size:11.5px;font-weight:600;padding:1px 8px;border-radius:999px;white-space:nowrap}
/* L444 */ .c-draft{color:#4E5763;background:#ECEEF1}.c-review{color:#6232B8;background:#F1EBFB}.c-changes{color:#994400;background:#FDEDDC}.c-approved{color:#1C4FBF;background:#E5EDFC}.c-rejected{color:#B42318;background:#FCE9E7}.c-applied{color:#1B7339;background:#E4F3E8}
/* L445 */ .apbox{margin-top:14px;padding:14px;border:1px solid var(--ln2);border-radius:8px;background:var(--sf2)}
/* L446 */ .tl{list-style:none;margin:0;padding:0}
/* L447 */ .tl li{padding:6px 0;border-bottom:1px solid var(--ln);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
/* L448 */ .next{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:14px;padding:12px;border-radius:6px;background:#EEF2F8}
/* L449 */ .ex-t{border-bottom:1px solid var(--ln);padding-bottom:4px;margin-bottom:4px}
/* L450 */ .ex-a{display:grid;grid-template-columns:96px minmax(0,1fr) auto;gap:6px;align-items:center;width:100%;padding:5px 8px 5px 18px;border:0;background:none;text-align:left;cursor:pointer;font-size:12px;border-radius:4px}
/* L451 */ .ex-a:hover{background:var(--bg)}
/* L452 */ .ex-a.on{background:var(--acbg)}
/* L453 */ .ex-a .st{font-size:11px;padding:1px 7px}
/* L454 */ .clpick{display:grid;grid-template-columns:20px 100px minmax(0,1fr) auto;gap:8px;align-items:center;padding:5px 0;cursor:pointer}
/* L455 */ .vbox{margin-top:12px;padding:12px;border:1px solid var(--ln);border-radius:6px;background:var(--sf2)}
/* L456 */ .msg-sm{margin:2px 0;color:var(--ink2);font-size:12.5px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
/* L457 */ .sc{display:inline-block;font-size:11.5px;font-weight:600;padding:1px 7px;border-radius:4px;white-space:nowrap}
/* L458 */ .sc-ok{color:var(--ok);background:var(--okbg)}.sc-warn{color:var(--wn);background:var(--wnbg)}.sc-bad{color:var(--dg);background:var(--dgbg)}.sc-none{color:var(--ink3);background:#ECEEF1}
/* L459 */ .sch-sub{font-size:12px}
/* L460 */ .gantt{position:relative}
/* L461 */ .g-row{display:grid;align-items:stretch;border-bottom:1px solid var(--ln)}
/* L462 */ .g-row.task{cursor:pointer;background:var(--sf)}
/* L463 */ .g-row.task:hover{background:#F6F8FC}
/* L464 */ .g-row.task.sel{background:var(--acbg)}
/* L465 */ .g-row.grp{background:var(--sf2)}
/* L466 */ .g-row.grp.ph{background:#EDEFF3}
/* L467 */ .g-head{position:sticky;top:0;z-index:4;background:var(--sf2);font-size:11px;color:var(--ink2)}
/* L468 */ .g-lab{position:sticky;left:0;z-index:2;display:flex;flex-wrap:wrap;align-items:center;gap:2px 8px;padding:6px 10px;background:inherit;border-right:1px solid var(--ln);min-width:0}
/* L469 */ .g-head .g-lab{z-index:5;font-size:12px;font-weight:600}
/* L470 */ .g-row.task .g-lab{flex-direction:column;align-items:flex-start;justify-content:center}
/* L471 */ .g-days{display:grid}
/* L472 */ .gd{border-left:1px solid #E6E9EE;padding:6px 0 4px 3px;white-space:nowrap;overflow:visible;font-family:var(--mono);height:30px}
/* L473 */ .gd.we{background:#F0F1F4;color:var(--ink3)}
/* L474 */ .gd.td{background:#FDECEA;color:var(--dg);font-weight:700}
/* L475 */ .gd.tg{box-shadow:inset -2px 0 0 #6232B8}
/* L476 */ .g-track{position:relative;min-height:38px;background-image:linear-gradient(90deg,#EEF0F3 1px,transparent 1px);background-size:22px 100%}
/* L477 */ .grp .g-track{min-height:30px}
/* L478 */ .g-today{position:absolute;top:0;bottom:0;width:2px;background:#D93025;z-index:1}
/* L479 */ .g-tgt{position:absolute;top:0;bottom:0;width:0;border-left:2px dashed #6232B8;z-index:1}
/* L480 */ .g-plan{position:absolute;top:7px;height:8px;border-radius:3px;background:#DDE2EA;border:1px solid #AEB6C2}
/* L481 */ .g-act,.g-fc{position:absolute;top:19px;height:12px;border-radius:3px;overflow:hidden}
/* L482 */ .g-act.done{background:#2E8B57}
/* L483 */ .g-act.done .g-fill{display:none}
/* L484 */ .g-act.run{background:#C9D7F6;border:1px solid #2453CF}
/* L485 */ .g-act.run .g-fill{display:block;height:100%;background:#2453CF}
/* L486 */ .g-fc{background:repeating-linear-gradient(45deg,#E5EDFC 0 4px,#F4F7FE 4px 8px);border:1px dashed #6B8BE0}
/* L487 */ .g-fc .g-fill{display:none}
/* L488 */ .g-sum{position:absolute;top:11px;height:8px;background:#59616D;border-radius:2px}
/* L489 */ .g-legend{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;padding:8px 2px 0;font-size:12px;color:var(--ink2)}
/* L490 */ .g-legend span{display:inline-flex;align-items:center;gap:6px}
/* L491 */ .lg{display:inline-block;width:22px;height:9px;border-radius:2px}
/* L492 */ .lg-plan{background:#DDE2EA;border:1px solid #AEB6C2}.lg-done{background:#2E8B57}.lg-run{background:linear-gradient(90deg,#2453CF 50%,#C9D7F6 50%);border:1px solid #2453CF}.lg-fc{background:repeating-linear-gradient(45deg,#E5EDFC 0 4px,#F4F7FE 4px 8px);border:1px dashed #6B8BE0}
/* L493 */ .g-range{position:absolute;top:24px;height:2px;background:#9AA8C2;opacity:.85}
/* L494 */ .gd.bk{background:repeating-linear-gradient(135deg,#F6E3E1 0 3px,#FBF1F0 3px 6px);color:#A23B2E}
/* L495 */ .gd.past{color:var(--ink3)}
/* L496 */ .lg-range{height:2px;background:#9AA8C2}.lg-bk{background:repeating-linear-gradient(135deg,#F6E3E1 0 3px,#FBF1F0 3px 6px);border:1px solid #E3B7B1}
/* L497 */ .cbars{display:flex;align-items:flex-end;gap:10px;margin-top:12px;padding:8px 10px;border:1px solid var(--ln);border-radius:6px;background:#FAFBFC}
/* L498 */ .cday{display:flex;flex-direction:column;align-items:center;gap:3px;flex:1;min-width:0;font-size:11px}
/* L499 */ .cbar{display:block;width:100%;max-width:28px;background:#2453CF;border-radius:2px 2px 0 0}
/* L500 */ .cbar.low{background:#D93025}
/* L501 */ .cpct{font-size:11px;color:var(--ink2)}
/* L502 */ .agbox{border:1px solid var(--ln);border-radius:6px;padding:10px 12px;margin-bottom:10px;background:var(--sf)}
/* L503 */ .rp-gen{margin-bottom:16px}.rp-gen-row{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center}.rp-gen-f{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap}.rp-gen-f .flabel{margin:0;white-space:nowrap}.rp-gen-f .inp{width:150px}
/* L504 */ .rp-wrap{display:grid;grid-template-columns:320px minmax(0,1fr);gap:16px;align-items:start}
/* L505 */ .rp-side{display:flex;flex-direction:column;gap:16px}.rp-side .card{margin:0}
/* L506 */ .rp-list{display:flex;flex-direction:column;gap:4px;max-height:calc(100vh - 330px);min-height:240px;overflow:auto}
/* L507 */ .rp-row{display:flex;flex-direction:column;gap:3px;text-align:left;padding:8px 10px;border:1px solid var(--ln);border-radius:6px;background:var(--sf);cursor:pointer;font:inherit;color:inherit}
/* L508 */ .rp-row:hover{background:#F5F7FA}.rp-row.on{border-color:#2453CF;background:#EEF3FF;box-shadow:inset 3px 0 0 #2453CF}
/* L509 */ .rp-r1{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.rp-r2{font-size:12px}
/* L510 */ .tag.rk-w{background:#EDE9FE;color:#5B21B6}.tag.rk-c{background:#E6F4EA;color:#1E6B34}
/* L511 */ .rp-bar{display:flex;gap:8px;align-items:center;margin-bottom:10px}
/* L512 */ .rpt-doc{background:#fff;border:1px solid var(--ln);border-radius:8px;padding:32px 40px;color:#1F2933}
/* L513 */ .rpt-h{border-bottom:2px solid #1F2933;padding-bottom:12px;margin-bottom:16px}
/* L514 */ .rpt-kind{font-size:12px;color:#2453CF;font-weight:600;letter-spacing:.02em}
/* L515 */ .rpt-h h2{margin:4px 0 8px;font-size:22px}
/* L516 */ .rpt-meta{display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:#3E4651}
/* L517 */ .rpt-snap{margin:8px 0 0;font-size:12px;color:#6B7480}
/* L518 */ .rpt-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:18px}
/* L519 */ .rpt-kpi{border:1px solid var(--ln);border-radius:6px;padding:10px 12px;display:flex;flex-direction:column;gap:2px}
/* L520 */ .rpt-kl{font-size:12px;color:#6B7480}.rpt-kv{font-size:20px}.rpt-ks{font-size:12px;color:#6B7480}
/* L521 */ .rpt-sec{margin-bottom:18px;break-inside:avoid}.rpt-sec h3{font-size:15px;margin:0 0 8px;padding-bottom:4px;border-bottom:1px solid var(--ln)}
/* L522 */ .rpt-sec p{margin:0 0 6px}
/* L523 */ .rpt-li{display:flex;gap:8px;align-items:center;padding:4px 0;border-bottom:1px dashed #E5E8EC;font-size:13px;flex-wrap:wrap}
/* L524 */ .rpt-ul{margin:0;padding-left:20px;line-height:1.7}
/* L525 */ .rpt-trend{display:flex;flex-direction:column;font-size:13px}
/* L526 */ .rpt-tr{display:grid;grid-template-columns:90px minmax(140px,1.2fr) minmax(140px,1.2fr) minmax(70px,.6fr) minmax(80px,.6fr) minmax(90px,.7fr);gap:8px;align-items:end;padding:4px 0;border-bottom:1px solid #EEF0F3}
/* L527 */ .rpt-tr.ext{grid-template-columns:90px minmax(180px,1.5fr) minmax(70px,.6fr) minmax(120px,1fr)}
/* L528 */ .rpt-tr.h{color:#6B7480;font-size:12px;align-items:center}
/* L529 */ .rpt-bc{display:flex;gap:6px;align-items:flex-end}.rpt-b{display:inline-block;width:14px;border-radius:2px 2px 0 0}.rpt-b.up{background:#2453CF}.rpt-b.at{background:#8A9BB8}
/* L530 */ .rpt-f{margin-top:24px;padding-top:8px;border-top:1px solid var(--ln);font-size:11px;color:#8A939E}
/* L531 */ @media (max-width: 1200px){.rp-wrap{grid-template-columns:1fr}}
/* L532 */ @media print{
/* L533 */   @page{size:A4;margin:14mm}
/* L534 */   body *{visibility:hidden !important}
/* L535 */   .rpt-doc,.rpt-doc *{visibility:visible !important}
/* L536 */   .rpt-doc{position:absolute;left:0;top:0;width:100%;max-width:none;border:0;padding:0}
/* L537 */   .rpt-doc .reflink{color:inherit;text-decoration:none}
/* L538 */ }
/* L539 */ .rpt-note{margin:-6px 0 14px;font-size:13px;color:#3E4651}
/* L540 */ .rpt-card{border:1px solid var(--ln);border-radius:6px;padding:10px 12px;margin-bottom:8px;break-inside:avoid}
/* L541 */ .rpt-card.bad{border-color:#F0B8B0;background:#FFF8F7}
/* L542 */ .rpt-ch{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px;font-size:14px}
/* L543 */ .rpt-kv{display:grid;grid-template-columns:110px minmax(0,1fr);gap:3px 12px;font-size:13px}
/* L544 */ .rpt-kv>span:nth-child(odd){color:#6B7480}
/* L545 */ .rpt-moved{font-size:13px;display:flex;flex-direction:column;gap:2px;padding-left:4px}
/* L546 */ .rpt-tbl{display:flex;flex-direction:column;font-size:12.5px;border-top:1px solid var(--ln)}
/* L547 */ .rpt-trw{display:grid;gap:8px;padding:5px 2px;border-bottom:1px solid #EEF0F3;align-items:start;break-inside:avoid}
/* L548 */ .rpt-trw.h{color:#6B7480;font-size:12px;background:#F7F8FA}
/* L549 */ .rpt-trw.at{grid-template-columns:96px 148px 150px 120px 56px minmax(0,1fr) 90px}
/* L550 */ .rpt-trw.nx{grid-template-columns:90px minmax(0,1.4fr) 80px 100px 160px minmax(0,1.2fr)}
/* L551 */ .rpt-trw.al{grid-template-columns:56px 86px minmax(0,1.6fr) 90px 110px 56px 76px 66px 90px 66px}
/* L552 */ .rpt-appx{break-before:page}
/* L553 */ .nav-i.off{opacity:.45}
/* L554 */ .ckl{display:block;font-size:12px;margin-top:3px;word-break:break-all}
/* L555 */ .bsteps{display:flex;flex-direction:column;gap:6px}
/* L556 */ .bs{display:grid;grid-template-columns:40px minmax(0,1fr);gap:8px;padding:6px 8px;border-radius:6px;border:1px solid var(--ln)}
/* L557 */ .bs-run{border-color:#E8B44C;background:#FFF9EC}.bs-done{background:#F6FBF7}
/* L558 */ .bs-n{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;background:#EEF0F3;font-size:12px;font-weight:600}
/* L559 */ .bs-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px}
/* L560 */ .dr-tree{border:1px solid var(--ln);border-radius:6px;max-height:460px;overflow:auto;padding:6px 10px}
/* L561 */ .dr-ph{font-weight:700;padding:6px 0 2px}.dr-wp{font-weight:600;padding:3px 0 2px 14px}
/* L562 */ .dr-t{display:flex;flex-direction:column;gap:2px;padding:3px 0 3px 30px;border-bottom:1px dashed #EEF0F3;font-size:13px}
/* L563 */ .rs-grid{display:grid;grid-template-columns:minmax(0,1fr) 60px;gap:3px 10px;font-size:13px}
/* L564 */ .danger-zone{border-color:#F0B8B0}
/* L565 */ .btn.danger{background:#C5221F;border-color:#C5221F;color:#fff}.btn.danger:disabled{opacity:.45}
/* L566 */ .pv-card{border-style:dashed}
/* L567 */ .pv-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
/* L568 */ .pv-i{display:flex;flex-direction:column;gap:3px;text-align:left;padding:8px 10px;border:1px solid var(--ln);border-radius:6px;background:var(--sf);cursor:pointer;font:inherit;color:inherit;font-size:13px}
/* L569 */ .pv-i:hover{border-color:#2453CF;background:#EEF3FF}
/* L570 */ @media (max-width: 1300px){.pv-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
/* L571 */ .faultbar{display:flex;gap:10px;align-items:center;justify-content:center;padding:4px 12px;background:#FFF4E0;color:#8A5300;font-size:12.5px;border-bottom:1px dashed #F0C98A}
/* L572 */ .errbar{display:flex;gap:12px;align-items:flex-start;margin:12px 24px 0;padding:12px 14px;border:1px solid #F0B8B0;border-left:4px solid #C5221F;border-radius:6px;background:#FFF5F4;color:#7A1C14}
/* L573 */ .errbar .ico{flex:none;margin-top:2px;stroke:#C5221F}
/* L574 */ .errbar-b{flex:1;font-size:13.5px;line-height:1.55}.errbar-a{display:flex;gap:6px;flex:none}
/* L575 */ .skel{display:flex;flex-direction:column;gap:12px;margin-top:8px}
/* L576 */ .sk{background:linear-gradient(90deg,#EEF0F3 0%,#F6F7F9 50%,#EEF0F3 100%);background-size:200% 100%;animation:skm 1.2s linear infinite;border-radius:6px;height:16px}
/* L577 */ .sk.w40{width:40%}.sk.w60{width:60%}.sk.w80{width:80%}.sk.w100{width:100%}
/* L578 */ .sk-row{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.sk.card{height:84px}
/* L579 */ @keyframes skm{0%{background-position:200% 0}100%{background-position:-200% 0}}
/* L580 */ @media (prefers-reduced-motion: reduce){.sk{animation:none}}
/* L581 */ .load-err{border-color:#F0B8B0;max-width:760px}.load-err h3{margin-top:0}
/* L582 */ .bs-fail{border-color:#F0B8B0;background:#FFF5F4}
/* L583 */ .pv-i.err:hover{border-color:#C5221F;background:#FFF5F4}
/* L584 */ .skp{display:flex;flex-direction:column;gap:16px}
/* L585 */ .sk-r{display:grid;gap:16px;align-items:start}
/* L586 */ .sk-c{display:flex;flex-direction:column;gap:10px;min-width:0}
/* L587 */ .sk-c.card{border:1px solid var(--ln);border-radius:8px;padding:16px;background:var(--sf)}
/* L588 */ .sk{max-width:100%}
/* L589 */ .topbar{position:sticky;top:0;left:0;right:0;height:3px;z-index:40;overflow:hidden;background:transparent}
/* L590 */ .topbar span{display:block;height:100%;width:40%;background:#2453CF;animation:tb 0.9s ease-in-out infinite}
/* L591 */ @keyframes tb{0%{transform:translateX(-100%)}100%{transform:translateX(260%)}}
/* L592 */ .main.dim .page{opacity:.55;pointer-events:none;transition:opacity .15s}
/* L593 */ .dimchip{position:absolute;top:12px;right:24px;z-index:41;display:inline-flex;gap:8px;align-items:center;padding:6px 12px;border-radius:16px;background:#1F2933;color:#fff;font-size:12.5px;box-shadow:0 4px 14px rgba(0,0,0,.18)}
/* L594 */ .main{position:relative}
/* L595 */ .bspin{display:inline-block;width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;margin-right:6px;vertical-align:-1px;animation:bsp .7s linear infinite}
/* L596 */ .bspin.lg{width:20px;height:20px;border-width:3px;color:#2453CF}
/* L597 */ @keyframes bsp{to{transform:rotate(360deg)}}
/* L598 */ .area-load{display:flex;gap:10px;align-items:center;justify-content:center;min-height:220px;color:var(--ink2)}
/* L599 */ @media (prefers-reduced-motion: reduce){.topbar span{animation:none;width:100%;opacity:.6}.bspin{animation-duration:2s}}
/* L600 */ .tag.sub{background:#EEF3FF;color:#1F3F99}
/* L601 */ .subline{display:block;padding:1px 0}
/* L602 */ .subtext{grid-column:1/-1;padding:8px 12px;background:#F7F8FA;border-bottom:1px solid #EEF0F3}
/* L603 */ .subtext pre{margin:0 0 4px;white-space:pre-wrap;font:inherit;font-size:12.5px}
/* L604 */ .rpc{margin-top:12px}
/* L605 */ .runrow{border:1px solid var(--ln);border-radius:6px;padding:8px 10px;margin-bottom:8px;background:var(--sf)}
/* L606 */ .tag.lock{background:#FFF4E0;color:#8A5300;border-color:#F0C98A}
/* L607 */ .lg-today{width:2px;height:14px;background:#D93025}.lg-tgt{width:0;height:14px;border-left:2px dashed #6232B8}
/* L608 */ .kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}
/* L609 */ .kpi{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:14px 16px;border:1px solid var(--ln);border-radius:8px;background:var(--sf);cursor:pointer;text-align:left}
/* L610 */ .kpi:hover{border-color:#9CB4EE;background:#FBFCFF}
/* L611 */ .kpi-l{font-size:12px;font-weight:600;color:var(--ink2)}
/* L612 */ .kpi-v{font-size:28px;font-weight:700;font-family:var(--mono);line-height:1.2}
/* L613 */ .kpi-s{font-size:11.5px;color:var(--ink3)}
/* L614 */ .kpi.ok .kpi-v{color:var(--ok)}.kpi.run .kpi-v{color:#1C4FBF}.kpi.bad{border-color:#F0B4AD}.kpi.bad .kpi-v{color:var(--dg)}
/* L615 */ .dgrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:16px}
/* L616 */ .dgrid .card{margin-bottom:0}
/* L617 */ .dp-h{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap}
/* L618 */ .dp-h h3{margin:0;font-size:14px;display:flex;gap:6px;align-items:center}
/* L619 */ .dp-n{font-family:var(--mono);font-weight:700;font-size:13px;padding:0 8px;border-radius:10px;background:#ECEEF1;color:var(--ink2)}
/* L620 */ .dp-n.bad{background:var(--dgbg);color:var(--dg)}
/* L621 */ .dl-i{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px;align-items:center;width:100%;padding:7px 8px;border:0;border-top:1px solid var(--ln);background:none;text-align:left;cursor:pointer;font-size:12.5px}
/* L622 */ .dl-i:hover{background:#F6F8FC}
/* L623 */ .dl-i.rec{grid-template-columns:128px 44px 96px 84px minmax(0,1fr) auto}.dl-i.rec>span{white-space:nowrap}.dl-i.rec>.dl-t{white-space:nowrap}.dl-i.rec>:last-child{justify-self:end}
/* L624 */ .dl-t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* L625 */ .bar-r{display:grid;grid-template-columns:150px minmax(0,1fr) 36px;gap:10px;align-items:center;width:100%;padding:5px 4px;border:0;background:none;cursor:pointer;text-align:left;font-size:12.5px;border-radius:4px}
/* L626 */ .bar-r:hover{background:#F6F8FC}
/* L627 */ .bar-r.dim{color:var(--ink3)}
/* L628 */ .bar-t{height:10px;border-radius:3px;background:#EEF0F3;overflow:hidden}
/* L629 */ .bar-x{display:block;height:100%;background:#4A6FD8;border-radius:3px}
/* L630 */ .bar-n{text-align:right}
/* L631 */ .pgtabs{margin-bottom:12px}
/* L632 */ .pgtabs button{height:34px;padding:0 14px;font-size:13px}
/* L633 */ .fbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
/* L634 */ .gtr.pick{background:var(--acbg)}
/* L635 */ .gtb .gtr.pick:hover,.gtb .gtr.ph:hover{background:#E4EBFA}
/* L636 */ .evrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 0;border-top:1px solid var(--ln)}
/* L637 */ .evp{font-size:12px;overflow-wrap:anywhere}
/* L638 */ .gtr.ph{background:#F1F3F6;font-weight:600}
/* L639 */ @media (max-width:1280px){.dgrid{grid-template-columns:repeat(2,minmax(0,1fr))}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
/* L640 */ @media (max-width:1280px){.three{grid-template-columns:280px minmax(0,1fr)}.three > aside:last-child{grid-column:1 / -1}}
/* L641 */ @media (max-width:1100px){.two,.three{grid-template-columns:1fr}.cmp{grid-template-columns:1fr}.two .side{position:static}}
/* L642 */ @media (max-width:1400px){.detail{width:660px}}
/* L643 */ @media (max-width:1100px){.detail{position:fixed;top:64px;right:0;bottom:0;left:0;width:auto;border-radius:0;z-index:30}.summary{grid-template-columns:repeat(2,minmax(0,1fr))}.kv{grid-template-columns:110px minmax(0,1fr)}.cols2{grid-template-columns:1fr}.frow{grid-template-columns:1fr;gap:4px}.choice{grid-template-columns:repeat(2,minmax(0,1fr))}.gate-r{grid-template-columns:1fr auto}}
/* L644 */ @media (max-width:760px){.nav{width:60px}.nav-l,.nav-ph{display:none}.proj,.hdr-sep,.phase-tag,.user{display:none}.page{padding:14px 12px 0}.search{width:100%}.cmp-row{grid-template-columns:1fr}}
```

## 템플릿 인라인 스타일 전체

| 원본 줄 | style 값 |
|---:|---|
| 688 | {{r.style}} |
| 688 | {{b.style}} |
| 698 | justify-content: flex-start |
| 708 | grid-template-columns: minmax(0,1.5fr) minmax(0,1fr) |
| 716 | margin: 4px 0 0 |
| 716 | grid-template-columns: 120px 52px minmax(0,1fr); min-width: 0 |
| 719 | margin: 2px 0 0 |
| 719 | margin: 6px 0 0 |
| 719 | grid-template-columns: 148px minmax(160px,1.4fr) minmax(140px,1fr); min-width: 0 |
| 720 | width: 170px |
| 721 | flex-direction: column; align-items: stretch; gap: 6px |
| 727 | margin-right: auto |
| 730 | display: flex; flex-direction: column; gap: 16px |
| 731 | margin: 0 |
| 733 | margin: 0; padding-left: 18px; line-height: 1.8 |
| 739 | margin: 8px 0 0 |
| 741 | margin: 0 |
| 744 | margin: 0 |
| 750 | font-size: 15px |
| 752 | margin-top: 4px |
| 752 | margin-top: 6px |
| 753 | grid-template-columns: minmax(0,1fr) minmax(0,1.4fr) |
| 755 | display: flex; gap: 6px; align-items: center |
| 756 | font-size: 12px |
| 756 | font-size: 12px |
| 757 | white-space: pre-wrap; margin: 0 |
| 763 | margin: 0 0 8px |
| 771 | margin-top: 10px |
| 771 | margin-right: auto |
| 777 | margin: 0 0 4px |
| 778 | margin: 0 0 8px |
| 779 | align-self: flex-start |
| 780 | margin-top: 12px |
| 782 | margin-right: auto |
| 785 | margin: 0 |
| 793 | margin-bottom: 10px |
| 809 | margin: 8px 4px |
| 844 | {{rowStyle}} |
| 859 | {{r.style}} |
| 861 | {{r.indent}} |
| 866 | width: {{r.pct}}% |
| 872 | {{r.style}} |
| 874 | {{r.indent}} |
| 887 | width: {{r.pct}}% |
| 888 | font-weight: 600 |
| 901 | {{gRowStyle}} |
| 902 | font-weight: 400 |
| 903 | {{gDaysStyle}} |
| 907 | {{gRowStyle}} |
| 908 | {{r.indent}} |
| 909 | {{gTrackStyle}} |
| 909 | {{gTodayStyle}} |
| 909 | {{gTgtStyle}} |
| 909 | {{r.gPlan}} |
| 913 | {{gRowStyle}} |
| 914 | padding-left: 40px |
| 915 | {{gTrackStyle}} |
| 915 | {{gTodayStyle}} |
| 915 | {{gTgtStyle}} |
| 915 | {{r.gPlan}} |
| 915 | {{r.gRange}} |
| 915 | {{r.gFc}} |
| 915 | width: {{r.pct}}% |
| 935 | font-size: 12px |
| 950 | width: {{dt.clPct}}% |
| 954 | width: 90px |
| 954 | width: {{dt.sch.pct}}% |
| 982 | display: flex; gap: 6px |
| 984 | margin: 0 0 14px |
| 984 | margin: 4px 0 0; color: inherit |
| 986 | margin-bottom: 8px |
| 999 | margin-bottom: 8px |
| 1000 | {{bk.grid}} |
| 1002 | {{rw.grid}} |
| 1023 | margin-top: 18px |
| 1023 | margin-right: auto |
| 1062 | margin: 0 |
| 1068 | margin: 0 |
| 1068 | margin-left: 4px |
| 1068 | display: flex; gap: 6px; align-items: center |
| 1069 | margin: 4px 0 0 |
| 1071 | margin-top: 8px |
| 1075 | margin-right: auto |
| 1080 | margin: 12px 0 6px |
| 1080 | font-weight: 400 |
| 1081 | margin: 0 0 6px |
| 1082 | grid-template-columns: 120px minmax(0,1fr) |
| 1083 | margin: 0 |
| 1084 | grid-template-columns: 110px 60px minmax(0,1fr) |
| 1088 | margin: 0 0 6px |
| 1089 | margin: 0 |
| 1090 | grid-template-columns: 170px 70px minmax(0,1fr) 120px; min-width: 0 |
| 1092 | justify-content: flex-start; margin-top: 8px |
| 1093 | margin: 8px 0 0 |
| 1102 | margin-top: 8px |
| 1108 | margin: 6px 0 0 |
| 1117 | display: flex; gap: 8px; align-items: center; flex-wrap: wrap |
| 1117 | max-width: 80px |
| 1117 | max-width: 80px |
| 1117 | max-width: 80px |
| 1117 | max-width: 90px |
| 1118 | max-width: 160px |
| 1125 | margin-right: auto |
| 1134 | margin: 0 0 14px |
| 1142 | margin: 0 |
| 1144 | {{sec.tbl.grid}} |
| 1150 | display: flex; gap: 6px |
| 1162 | margin: 0 0 14px |
| 1163 | margin: 0 0 14px |
| 1167 | padding: 0 |
| 1169 | flex: 1; min-width: 240px |
| 1171 | margin: 0 0 8px |
| 1177 | margin: 8px 0 0 |
| 1182 | {{depGrid}} |
| 1184 | {{p.grid}} |
| 1197 | {{succGrid}} |
| 1200 | {{p.grid}} |
| 1216 | margin: 0 0 10px |
| 1224 | display: flex; gap: 6px |
| 1227 | margin: 0 0 8px |
| 1243 | margin: 0 |
| 1244 | {{bk.grid}} |
| 1252 | {{sec.rel.grid}} |
| 1257 | margin: 0 |
| 1258 | {{bk.grid}} |
| 1272 | margin: 0 0 14px |
| 1273 | margin: 0 0 14px |
| 1275 | {{clGrid}} |
| 1277 | {{ci.grid}} |
| 1293 | flex: 2; min-width: 240px |
| 1295 | flex: 1; min-width: 180px |
| 1306 | margin: 0 0 14px |
| 1312 | margin-top: 6px |
| 1313 | margin: 0 |
| 1330 | margin: 0 |
| 1331 | margin: 0; color: #8A1C12 |
| 1342 | {{histGrid}} |
| 1345 | {{h.grid}} |
| 1354 | margin: 0 0 14px |
| 1385 | padding: 0 |
| 1386 | padding: 0 |
| 1387 | padding: 0 |
| 1408 | margin-top: 4px |
| 1409 | display: flex; gap: 6px; align-items: center |
| 1410 | margin: 0 0 6px |
| 1410 | margin: 0 |
| 1416 | padding: 0 |
| 1416 | margin: 0 |
| 1419 | font-size: 12px |
| 1419 | font-size: 12px |
| 1429 | font-size: 12px |
| 1430 | margin: 0 0 8px; font-size: 18px |
| 1431 | grid-template-columns: 110px minmax(0,1fr); margin: 0 0 10px |
| 1436 | font-size: 12.5px |
| 1440 | margin: 0 0 10px |
| 1442 | margin: 0 0 10px |
| 1442 | grid-template-columns: minmax(220px,1fr) 80px 90px; min-width: 0 |
| 1443 | white-space: pre-wrap |
| 1445 | margin-top: 10px |
| 1445 | margin-right: auto |
| 1453 | margin: 0 0 8px |
| 1455 | margin: 0 |
| 1455 | grid-template-columns: 60px 100px minmax(180px,1fr) 170px 148px; min-width: 0 |
| 1460 | margin: 0 0 8px |
| 1461 | grid-template-columns: 130px minmax(0,1fr); margin: 0 0 10px |
| 1462 | margin-left: auto |
| 1468 | margin-top: 4px |
| 1468 | list-style: none |
| 1471 | grid-template-columns: 150px minmax(0,1fr) |
| 1477 | margin: 0 0 8px |
| 1479 | margin: 0 |
| 1479 | grid-template-columns: minmax(220px,1fr) 110px 148px 110px 100px 100px; min-width: 0 |
| 1485 | margin-top: 2px |
| 1486 | margin: 0 0 6px |
| 1486 | margin: 0 |
| 1488 | display: flex; gap: 8px; align-items: center; flex-wrap: wrap |
| 1488 | margin-right: auto |
| 1489 | display: flex; gap: 8px; align-items: center; flex-wrap: wrap |
| 1489 | margin-right: auto |
| 1497 | margin: 14px 0 6px |
| 1498 | margin: 0 |
| 1503 | margin: 0 0 8px |
| 1505 | margin: 0 |
| 1511 | margin: 0 0 10px |
| 1518 | color: var(--wn) |
| 1527 | margin: 0 0 8px |
| 1528 | padding: 0 |
| 1529 | margin: 0 |
| 1539 | font-size: 12.5px; word-break: break-all |
| 1543 | font-size: 12px |
| 1544 | margin: 0 0 4px; font-size: 18px; word-break: break-all |
| 1545 | margin: 0 0 10px |
| 1546 | grid-template-columns: 110px minmax(0,1fr); margin: 0 0 12px |
| 1552 | grid-template-columns: 110px minmax(0,1fr); margin: 0 0 10px |
| 1556 | margin: 0 0 10px |
| 1556 | grid-template-columns: 70px minmax(160px,1fr) minmax(160px,1.4fr); min-width: 0 |
| 1560 | grid-template-columns: 110px minmax(0,1fr); margin: 0 0 10px |
| 1562 | margin: 0 0 10px |
| 1562 | grid-template-columns: minmax(130px,.8fr) 148px minmax(200px,2fr); min-width: 0 |
| 1562 | font-size: 12px |
| 1563 | grid-template-columns: 130px minmax(0,1fr); margin: 0 0 10px |
| 1570 | margin: 0 0 10px |
| 1574 | grid-template-columns: 110px minmax(0,1fr) |
| 1575 | grid-template-columns: 110px minmax(0,1fr) |
| 1576 | grid-template-columns: 150px minmax(0,1fr) |
| 1577 | grid-template-columns: 110px minmax(0,1fr) |
| 1587 | margin: 0 0 8px |
| 1589 | margin: 0 |
| 1597 | margin: 0 0 8px |
| 1608 | margin: 0 |
| 1608 | grid-template-columns: 48px 150px minmax(140px,.8fr) minmax(200px,2fr); min-width: 0 |
| 1620 | margin: 4px 0 0 |
| 1621 | margin: 0 |
| 1625 | margin: 0 |
| 1625 | margin: 0 |
| 1626 | margin: 6px 0; color: #3E4651 |
| 1627 | grid-template-columns: 110px minmax(0,1fr) 110px minmax(0,1fr) |
| 1628 | margin-top: 6px |
| 1630 | margin: 8px 0 0 |
| 1631 | {{pl.mGrid}} |
| 1632 | {{m.grid}} |
| 1638 | margin: 0 |
| 1646 | margin: 0 |
| 1654 | margin: 0 0 8px; color: #3E4651 |
| 1665 | margin: 8px 0 0 |
| 1673 | {{diffGrid}} |
| 1675 | {{r.grid}} |
| 1678 | margin: 4px 0 0; color: inherit |
| 1679 | margin-right: auto |
| 1692 | margin: 0 |
| 1696 | margin: 0 0 6px |
| 1696 | margin: 0 |
| 1699 | margin: 0 |
| 1699 | display: flex; gap: 8px; align-items: center; flex-wrap: wrap |
| 1701 | margin-top: 14px |
| 1705 | {{diffGrid}} |
| 1707 | {{r.grid}} |
| 1711 | margin: 4px 0 0; color: inherit |
| 1713 | font-weight: 400 |
| 1715 | {{impGrid}} |
| 1717 | {{im.grid}} |
| 1728 | border: 0; padding-top: 8px |
| 1732 | margin: 0 0 8px |
| 1732 | border: 0; padding-top: 0 |
| 1735 | margin: 0 0 8px |
| 1735 | border: 0; padding-top: 0 |
| 1761 | margin: 0 |
| 1761 | display: flex; gap: 8px; align-items: center |
| 1764 | margin: 8px 0 0 |
| 1769 | margin-top: 0 |
| 1772 | display: flex; gap: 8px; align-items: center |
| 1772 | max-width: 120px |
| 1776 | margin-right: auto |
| 1783 | margin-top: 0 |
| 1786 | display: flex; gap: 8px; align-items: center |
| 1786 | max-width: 120px |
| 1796 | margin-right: auto |
| 1803 | margin-top: 0 |
| 1806 | margin-right: auto |
| 1812 | margin-top: 0 |
| 1813 | margin: 0 |
| 1823 | margin: 4px 0; color: #3E4651 |
| 1825 | margin: 0 |
| 1833 | margin: 0 |
| 1834 | margin: 0; color: #8A1C12 |
| 1843 | margin: 0 |
| 1844 | margin: 0 0 6px |
| 1847 | margin-bottom: 6px |
| 1861 | margin-top: 0 |
| 1863 | margin: 4px 0 |
| 1863 | {{k.barW}} |
| 1863 | font-size: 11.5px |
| 1874 | margin: 0 0 8px |
| 1875 | margin: 0 |
| 1882 | width: {{b.pct}}% |
| 1885 | width: {{b.pct}}% |
| 1888 | margin-top: 16px |
| 1889 | margin: 0 |
| 1890 | margin: 0 |
| 1891 | {{db.gGrid}} |
| 1892 | {{g.grid}} |
| 1895 | margin-top: 16px |
| 1896 | margin: 0 |
| 1911 | {{vf.vGrid}} |
| 1913 | {{v.grid}} |
| 1926 | font-size: 12px |
| 1927 | margin: 0 0 8px |
| 1927 | margin: 0 |
| 1927 | display: flex; gap: 6px |
| 1932 | margin: 0; color: #8A1C12 |
| 1934 | margin-top: 16px |
| 1934 | font-weight: 400 |
| 1940 | margin-top: 10px |
| 1940 | flex: 1; min-width: 260px |
| 1948 | margin: 0 0 8px |
| 1950 | {{vf.evGrid}} |
| 1952 | {{e.grid}} |
| 1952 | font-weight: 500 |
| 1962 | {{vf.gGrid}} |
| 1964 | {{g.grid}} |
| 1975 | border-radius: 8px 8px 0 0 |
| 1977 | width: 140px |
| 1979 | width: 100%; margin: 0 |
| 1980 | width: 100%; margin: 0 |
| 1983 | border-top: 0; border-radius: 0 0 8px 8px |
| 1984 | {{hv.hGrid}} |
| 1986 | {{h.grid}} |
| 1997 | display: flex; gap: 6px; align-items: center |
| 1999 | grid-template-columns: 130px minmax(0,1fr); margin: 0 0 10px |
| 2004 | white-space: pre-wrap |
| 2008 | font-size: 12px |
| 2010 | margin: 8px 0 |
| 2010 | grid-template-columns: 80px 148px minmax(200px,1fr) 150px; min-width: 0 |
| 2011 | margin: 0 0 8px |
| 2011 | grid-template-columns: 90px minmax(220px,1fr) 60px 90px; min-width: 0 |
| 2013 | margin-right: auto |
| 2016 | margin: 0 0 10px |
| 2017 | margin: 0 |
| 2018 | grid-template-columns: 50px 148px 84px minmax(200px,1.4fr) minmax(160px,1fr) minmax(150px,1fr) 84px; min-width: 0 |
| 2019 | grid-template-columns: 50px 148px 84px minmax(200px,1.4fr) minmax(160px,1fr) minmax(150px,1fr) 84px; min-width: 0 |
| 2022 | margin-top: 10px |
| 2025 | margin: 6px 0 0 |
| 2028 | margin: 10px 0 0 |
| 2028 | margin: 6px 0 0 |
| 2028 | grid-template-columns: 140px minmax(200px,1.4fr) minmax(160px,1fr); min-width: 0 |
| 2030 | grid-template-columns: minmax(0,1.3fr) minmax(0,1fr) |
| 2034 | grid-template-columns: 110px minmax(0,1fr) |
| 2041 | width: 160px |
| 2041 | width: {{pj.p.pct}}% |
| 2048 | margin: 0; color: #3E4651 |
| 2054 | max-width: 200px |
| 2055 | max-width: 200px |
| 2065 | grid-template-columns: minmax(120px,1fr) 70px 70px 70px 70px; min-width: 0 |
| 2066 | grid-template-columns: minmax(120px,1fr) 70px 70px 70px 70px; min-width: 0 |
| 2068 | margin-top: 12px |
| 2073 | margin-top: 16px |
| 2076 | {{pj.sGrid}} |
| 2078 | {{r.grid}} |
| 2078 | flex-direction: row; align-items: center; gap: 8px |
| 2078 | width: {{r.pct}}% |
| 2084 | margin: 0 |
| 2094 | margin: 0 |
| 2098 | margin-left: auto |
| 2100 | margin: 6px 0 0 |
| 2101 | margin: 8px 0 0 |
| 2107 | margin: 0 0 8px |
| 2108 | margin-bottom: 8px |
| 2109 | margin: 0 |
| 2122 | margin: 0 0 6px |
| 2122 | margin: 0 |
| 2126 | margin-right: auto |
| 2131 | margin: 6px 0 0 |
| 2131 | grid-template-columns: 112px minmax(160px,1fr) 70px minmax(120px,1fr); min-width: 0 |
| 2151 | {{x.upBar}} |
| 2151 | {{x.aBar}} |
| 2160 | margin-left: auto |
| 2169 | margin-left: auto |
| 2178 | margin-left: auto |
| 2198 | margin-left: auto |
| 2209 | flex-basis: 100% |
| 2235 | {{x.upBar}} |
| 2256 | margin: -4px 0 12px |
| 2259 | display: flex; gap: 8px; align-items: center |
| 2260 | margin: 0 0 8px |
| 2262 | grid-template-columns: 130px minmax(0,1fr); margin: 8px 0 |
| 2267 | margin: 0 0 8px |
| 2267 | grid-template-columns: 140px 90px minmax(160px,1fr) 70px; min-width: 0 |
| 2268 | grid-template-columns: 140px 90px minmax(160px,1fr) 70px; min-width: 0 |
| 2270 | max-width: 360px |
| 2271 | margin-left: auto |
| 2278 | padding-top: 7px |
| 2282 | display: flex; gap: 8px; align-items: center |
| 2283 | margin: 0 0 8px |
| 2284 | margin: 0 |
| 2285 | grid-template-columns: 180px 70px minmax(160px,1fr) minmax(200px,1.4fr); min-width: 0 |
| 2286 | grid-template-columns: 180px 70px minmax(160px,1fr) minmax(200px,1.4fr); min-width: 0 |
| 2293 | grid-template-columns: 130px minmax(0,1fr) |
| 2294 | font-size: 16px; font-weight: 700 |
| 2297 | {{cd.h}} |
| 2298 | margin-top: 12px |
| 2299 | margin: 0 |
| 2300 | grid-template-columns: 148px 148px 70px minmax(100px,1fr); min-width: 0 |
| 2302 | grid-template-columns: 148px 148px 70px minmax(100px,1fr); min-width: 0 |
| 2309 | margin: 0 0 6px |
| 2310 | grid-template-columns: 110px minmax(0,1fr); margin: 0 |
| 2311 | width: 140px |
| 2311 | {{ag.bar}} |
| 2319 | margin: 0 0 6px |
| 2320 | margin: 0 |
| 2321 | margin: 6px 0 0 |
| 2341 | margin-top: 0 |
| 2341 | font-weight: 400 |
| 2342 | grid-template-columns: 130px minmax(0,1fr); margin: 0 |
| 2343 | width: 140px |
| 2343 | {{cfg.cc.usedBar}} |
| 2349 | display: flex; flex-direction: column; gap: 2px |
| 2351 | margin: 14px 0 6px |
| 2351 | font-weight: 400 |
| 2353 | margin: 0 0 8px |
| 2362 | display: flex; gap: 4px; flex-wrap: wrap |
| 2365 | margin: 0 0 8px |
| 2365 | display: flex; gap: 6px; align-items: center |
| 2366 | margin: 0 |
| 2376 | margin: 6px 0 0 |
| 2378 | margin: 6px 0 |
| 2381 | margin-top: 10px |
| 2382 | margin: 0 0 6px |
| 2383 | grid-template-columns: 148px 120px minmax(120px,1fr) 148px; min-width: 0 |
| 2384 | grid-template-columns: 148px 120px minmax(120px,1fr) 148px; min-width: 0 |
| 2386 | margin-top: 10px |
| 2387 | margin: 0 |
| 2388 | grid-template-columns: 148px 72px 76px minmax(120px,1fr); min-width: 0 |
| 2390 | grid-template-columns: 148px 72px 76px minmax(120px,1fr); min-width: 0 |
| 2403 | margin-top: 14px |
| 2404 | margin-top: 4px |
| 2411 | margin-top: 0 |
| 2411 | font-weight: 400 |
| 2414 | margin: 0 0 6px |
| 2414 | font-size: 12px |
| 2415 | margin: 0 |
| 2416 | grid-template-columns: minmax(110px,1fr) 64px 148px 124px 84px; min-width: 0 |
| 2417 | grid-template-columns: minmax(110px,1fr) 64px 148px 124px 84px; min-width: 0 |
| 2417 | font-size: 11px; white-space: nowrap |
| 2421 | margin: 0 |
| 2430 | display: flex; flex-wrap: wrap; gap: 6px |
| 2437 | margin-bottom: 8px |
| 2440 | margin: 0 |
| 2441 | grid-template-columns: minmax(170px,1.1fr) 90px 100px minmax(150px,1fr) 100px 80px 120px 110px 150px; min-width: 0 |
| 2443 | grid-template-columns: minmax(170px,1.1fr) 90px 100px minmax(150px,1fr) 100px 80px 120px 110px 150px; min-width: 0 |
| 2447 | margin: 12px 0 4px |
| 2454 | margin: 0 0 8px |
| 2464 | margin: 0 |
| 2465 | grid-template-columns: 40px minmax(0,1fr) 120px 110px; min-width: 0 |
| 2466 | grid-template-columns: 40px minmax(0,1fr) 120px 110px; min-width: 0 |
| 2470 | margin: 12px 0 6px |
| 2471 | margin: 0 |
| 2484 | font-weight: 400 |
| 2485 | margin-bottom: 8px |
| 2486 | grid-template-columns: 110px minmax(120px,1fr) 60px; min-width: 0 |
| 2489 | width: 130px |
| 2489 | flex: 1; min-width: 140px |
| 2504 | margin: 0 |
| 2505 | grid-template-columns: minmax(140px,1fr) 100px; min-width: 0 |
| 2506 | grid-template-columns: minmax(140px,1fr) 100px; min-width: 0 |
| 2514 | margin: 0 0 10px |
| 2517 | margin: 0 0 12px |
| 2521 | font-size: 12.5px; word-break: break-all |
| 2528 | display: flex; gap: 4px; flex-wrap: wrap |
| 2531 | margin: 0 0 6px |
| 2533 | max-width: 360px |
| 2534 | max-width: 360px |
| 2537 | display: flex; gap: 6px; align-items: center |
| 2539 | margin-right: auto |
| 2543 | display: flex; gap: 8px; align-items: center |
| 2545 | grid-template-columns: 130px minmax(0,1fr); margin: 0 0 8px |
| 2552 | margin-left: auto |
| 2554 | margin: 0 0 6px |
| 2554 | margin: 0 0 8px |
| 2557 | max-width: 300px |
| 2558 | width: 90px |
| 2559 | max-width: 360px |
| 2560 | max-width: 300px |
| 2561 | max-width: 300px |
| 2563 | margin-right: auto |
| 2568 | display: flex; gap: 8px; align-items: center |
| 2569 | display: flex; gap: 8px; align-items: center; flex-wrap: wrap |
| 2569 | margin-right: auto |
| 2570 | margin: 0 |
| 2574 | word-break: break-all |
| 2575 | color: var(--dg) |
| 2576 | display: flex; gap: 4px; flex-wrap: wrap |
| 2579 | margin: 6px 0 0 |
| 2583 | margin: 0 0 12px |
| 2585 | display: flex; gap: 8px; align-items: center |
| 2586 | margin: 0 0 10px |
| 2591 | display: flex; gap: 8px; align-items: center; flex-wrap: wrap |
| 2592 | display: flex; gap: 8px; align-items: center; flex-wrap: wrap |
| 2592 | max-width: 400px |
| 2594 | display: flex; gap: 8px; align-items: center; flex-wrap: wrap |
| 2595 | max-width: 300px |
| 2596 | display: flex; gap: 8px; align-items: center; flex-wrap: wrap |
| 2596 | max-width: 240px |
| 2600 | display: flex; gap: 8px; align-items: center; flex-wrap: wrap |
| 2605 | margin-right: auto |
| 2610 | grid-template-columns: 110px minmax(0,1fr); margin: 0 0 10px |
| 2611 | white-space: normal |
| 2612 | margin: 8px 0 0 |
| 2613 | margin-right: auto |
| 2619 | display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 8px 0 0 |
| 2623 | display: flex; gap: 8px; align-items: center; flex-wrap: wrap |
| 2623 | max-width: 340px |
| 2624 | margin: 6px 0 0 |
| 2633 | font-size: 12px |
| 2634 | white-space: normal |
| 2639 | margin: 0 |
| 2639 | display: flex; gap: 6px |
| 2643 | margin: 6px 0 0 |
| 2648 | display: flex; gap: 8px; align-items: center |
| 2649 | margin: 0 0 8px |
| 2652 | grid-template-columns: 80px minmax(260px,1fr) minmax(200px,1fr) |
| 2654 | grid-template-columns: 80px minmax(260px,1fr) minmax(200px,1fr) |
| 2661 | grid-template-columns: minmax(280px,1fr) 90px minmax(200px,1fr) |
| 2662 | grid-template-columns: minmax(280px,1fr) 90px minmax(200px,1fr) |
| 2668 | margin: 10px 0 0 |
| 2669 | margin: 12px 0 6px |
| 2671 | margin: 6px 0 0 |
| 2681 | margin: 0 |
| 2694 | width: min(620px,100%) |
| 2698 | grid-template-columns: 110px minmax(0,1fr) |
| 2699 | margin-top: 10px |
| 2707 | width: min(600px,100%) |
| 2716 | margin: 10px 0 |
| 2717 | margin: 10px 0 0 |
| 2718 | margin: 10px 0 0 |
| 2719 | margin: 10px 0 0 |
| 2719 | margin-top: 6px |
| 2727 | width: min(860px,100%) |
| 2730 | grid-template-columns: 90px minmax(0,1fr); margin: 0 0 10px |
| 2736 | margin-bottom: 8px |
| 2738 | margin: 8px 0 0 |
| 2746 | width: min(620px,100%) |
| 2749 | margin: 0 0 10px |
| 2751 | margin: 10px 0 6px |
| 2752 | margin: 0 0 6px |
| 2753 | display: flex; gap: 8px; align-items: flex-start; padding: 4px 0 |
| 2753 | margin-top: 2px |
| 2753 | font-size: 12.5px |
| 2754 | margin: 12px 0 6px |
| 2755 | margin: 10px 0 0 |
| 2764 | width: min(820px,100%) |
| 2768 | margin-top: 12px |
| 2769 | margin-top: 0 |
| 2770 | margin-top: 0 |
| 2770 | margin: 0; padding-left: 18px |
| 2772 | margin: 10px 0 |
| 2774 | margin-top: 10px |
| 2798 | display: flex; gap: 8px; align-items: center |
| 2798 | max-width: 120px |
| 2799 | max-width: 160px |
| 2801 | flex-direction: row; gap: 16px; flex-wrap: wrap; align-items: center |
| 2822 | grid-template-columns: 120px minmax(0,1fr) |
| 2854 | margin: 0 0 14px |
| 2855 | max-width: none |
| 2858 | padding-top: 7px |
| 2860 | margin-top: 16px |
| 2862 | grid-template-columns: 180px 140px minmax(240px,1fr) 44px |
| 2864 | grid-template-columns: 180px 140px minmax(240px,1fr) 44px |
| 2873 | margin: 4px 0 0; color: inherit |
| 2875 | margin-top: 16px |
| 2877 | {{diffGrid}} |
| 2878 | {{r.grid}} |

## 아이콘 원문

아이콘은 외부 아이콘 패키지 대신 인라인 SVG와 NAV의 path 문자열이다. 아래는 실제 SVG 요소의 원문이다.

```html
<!-- L651 --> <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"></path></svg>
<!-- L667 --> <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="{{n.icon}}"></path></svg>
<!-- L679 --> <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l10 18H2zM12 10v5M12 18v.5"></path></svg>
<!-- L800 --> <svg class="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>
<!-- L805 --> <svg class="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16M14 6l6 6-6 6"></path></svg>
<!-- L813 --> <svg class="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4"></path></svg>
<!-- L862 --> <svg class="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>
<!-- L884 --> <svg class="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z"></path></svg>
<!-- L885 --> <svg class="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l4 4 10-10"></path></svg>
<!-- L908 --> <svg class="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>
<!-- L947 --> <svg class="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z"></path></svg>
<!-- L948 --> <svg class="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l4 4 10-10"></path></svg>
<!-- L965 --> <svg class="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z"></path></svg>
<!-- L1012 --> <svg class="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>
<!-- L1134 --> <svg class="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8h.01M11 12h1v5h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z"></path></svg>
<!-- L1169 --> <svg class="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4"></path></svg>
<!-- L1425 --> <svg class="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16M14 6l6 6-6 6"></path></svg>
<!-- L1538 --> <svg class="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16M14 6l6 6-6 6"></path></svg>
<!-- L1921 --> <svg class="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16M14 6l6 6-6 6"></path></svg>
<!-- L1976 --> <svg class="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4"></path></svg>
<!-- L2708 --> <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>
<!-- L2728 --> <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>
<!-- L2747 --> <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>
<!-- L2765 --> <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>
<!-- L2788 --> <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>
<!-- L2852 --> <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>
<!-- L2868 --> <svg class="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>
<!-- L2898 --> <svg class="ico sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l4 4 10-10"></path></svg>
```

NAV path 원문(3063–3076):

```js
const NAV = [
  {k:'dashboard', l:'대시보드', ph:'A', icon:'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z'},
  {k:'project', l:'프로젝트', ph:'A', icon:'M3 7h6l2 2h10v10H3z'},
  {k:'wbs', l:'WBS', ph:'A', icon:'M4 5h5M4 5v14M4 12h5M4 19h5M12 5h8M12 12h8M12 19h8'},
  {k:'design', l:'설계', ph:'A', icon:'M4 6h16M4 6v12h16V6M9 6v12M4 12h5'},
  {k:'planning', l:'Planning', ph:'A', icon:'M4 4h7v16H4zM13 4h7v16h-7zM6.5 8h2M15.5 8h2M6.5 12h2M15.5 12h2'},
  {k:'exec', l:'작업 실행', ph:'A', icon:'M8 5l11 7-11 7z'},
  {k:'verify', l:'검증', ph:'A', icon:'M12 3l8 3v6c0 4-3.5 7.5-8 9-4.5-1.5-8-5-8-9V6zM8.5 12l2.5 2.5 4.5-5'},
  {k:'ci', l:'빌드 · 통합', ph:'A', icon:'M4 7h16M4 12h10M4 17h7M17 14l3 3-3 3'},
  {k:'change', l:'변경 제안', ph:'A', icon:'M4 8h13l-3-3M20 16H7l3 3'},
  {k:'history', l:'이력', ph:'A', icon:'M12 8v4l3 2M4.6 9A8 8 0 1 1 4 12M4 4v5h5'},
  {k:'report', l:'보고서', ph:'A', icon:'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7M9 8h3'},
  {k:'settings', l:'설정', ph:'A', icon:'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2'}
];
```

## 로직에서 만드는 동적 스타일

스타일·레이아웃 관련 원문 문자열을 포함한 로직 줄이다. 비율/좌표/표 컬럼은 고정 토큰이 아니라 데이터에서 계산한다.

```js
// L3452
const SKB = (w, h, x) => ({style:'width: ' + w + '; height: ' + h + 'px;' + (x || '')});
// L3454
const SKR = (cols, cells) => ({style:'grid-template-columns: ' + cols, cells});
// L5005
      const f = document.createElement('iframe'); f.setAttribute('aria-hidden', 'true'); f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'; document.body.appendChild(f);
// L5007
      dc.open(); dc.write('<!doctype html><html lang="ko"><head><meta charset="utf-8"><base href="' + location.href + '"><title>' + name + '</title><style>' + css + '</style><style>html,body{background:#fff;margin:0}.rpt-doc{border:0;max-width:none;padding:0}.reflink{color:inherit;text-decoration:none;border:0;background:none;padding:0;font:inherit}@page{size:A4;margin:14mm}</style></head><body>' + el.outerHTML + '</body></html>'); dc.close();
// L5134
      return {key:id, isGroup:true, isTask:false, cls: kind === 'Phase' ? 'ph' : 'wp', style:grpStyle, wbs, title, kind: kind === 'Phase' ? 'Phase' : 'Work Package',
// L5162
    return Object.assign({key:t.id, isGroup:false, isTask:true, id:t.id, wbs:N.task[t.id], title:t.title, c, style:rowStyle, indent:'padding-left: 40px',
// L5234
    const depGrid = 'grid-template-columns: 110px minmax(160px,1fr) 150px 120px 90px 70px';
// L5235
    const succGrid = 'grid-template-columns: 110px minmax(160px,1fr) 150px 120px 150px';
// L5254
    const clGrid = 'grid-template-columns: 56px 100px minmax(180px,1fr) 70px 150px 170px 120px';
// L5261
    const histGrid = 'grid-template-columns: 148px 80px 100px minmax(200px,1fr) minmax(140px,220px)';
// L5433
    const grid = 'grid-template-columns: ' + cs.map(c => c.w === '1fr' ? 'minmax(180px,1fr)' : 'minmax(' + c.w + ',max-content)').join(' ');
// L5446
    const grid = 'grid-template-columns: ' + cs.map(c => c.w === '1fr' ? 'minmax(160px,1fr)' : c.w).join(' ') + ' 44px';
// L5656
    const grid = 'grid-template-columns: 100px 230px 148px minmax(150px,1fr) minmax(150px,1fr) 64px';
// L5688
    const grid = 'grid-template-columns: 110px minmax(160px,1fr) 120px minmax(220px,1.4fr)';
// L5967
    const mGrid = 'grid-template-columns: 110px minmax(160px,1fr) 90px 80px 80px 80px';
// L6325
    const gGrid = 'grid-template-columns: 90px minmax(150px,1fr) 70px 60px 60px 100px 60px 70px';
// L6339
    const vGrid = 'grid-template-columns: 96px 110px minmax(160px,1fr) 110px 88px 80px 148px 70px 80px';
// L6351
    const evGrid = 'grid-template-columns: minmax(240px,1.4fr) 100px 96px 110px minmax(140px,1fr) 90px';
// L6356
    const gGrid = 'grid-template-columns: 96px minmax(160px,1fr) 104px repeat(5, 92px) 92px';
// L6453
    const hGrid = 'grid-template-columns: 148px 96px 96px 110px minmax(220px,1fr) minmax(160px,260px)';
// L6465
    const sGrid = 'grid-template-columns: 70px 110px minmax(180px,1fr) 56px 56px 56px 56px 76px 128px 150px';
// L6978
    const rowStyle = 'grid-template-columns: 60px minmax(200px,2.4fr)' + shown.map(x => ' ' + x.w).join('');
// L6979
    const grpStyle = 'grid-template-columns: 60px minmax(0,1fr)';
// L7064
      diffGrid:'grid-template-columns: 100px 230px 148px minmax(150px,1fr) minmax(150px,1fr) 64px', impGrid:'grid-template-columns: 110px minmax(160px,1fr) 120px minmax(220px,1.4fr)', pg:{title:pg.title, desc:pg.desc, phase:pg.phase, items:pg.items.map(x => ({t:x}))}, goWbs: () => this.setState({nav:'wbs'}),
// L7078
      gRowStyle:'grid-template-columns: minmax(200px,300px) minmax(0,1fr)', gDays, gDaysStyle:'grid-template-columns: repeat(' + GD + ', minmax(0,1fr))',
// L7098
      depGrid:'grid-template-columns: 110px minmax(160px,1fr) 150px 120px 90px 70px', succGrid:'grid-template-columns: 110px minmax(160px,1fr) 150px 120px 150px',
// L7099
      clGrid:'grid-template-columns: 56px 100px minmax(180px,1fr) 70px 150px 170px 120px', histGrid:'grid-template-columns: 148px 80px 100px minmax(200px,1fr) minmax(140px,220px)',
```

## 메일 HTML 생성 원문(메일 전용 색·인라인 값 포함)

웹 CSS와 별개인 메일 값도 정본에 포함한다. 예: #E1E5EA 경계(P4008).

```js
// L4003
  mailHtml(d, r, view, to) {
// L4004
    const D = r.data, e = Sel.esc, dm = n => n == null ? '—' : Cal.md(n), dl = n => n == null ? '—' : Cal.ymd(n), per = r.from === r.to ? r.from : r.from + ' ~ ' + r.to;
// L4005
    const F = "font-family:'Pretendard GOV','Apple SD Gothic Neo','Malgun Gothic',sans-serif;", ext = view === 'ext', slack = D.fc != null && D.tgt != null ? D.tgt - D.fc : null;
// L4006
    const kp = ext ? [['완료', D.done.length + '건', '누적 ' + D.doneN + ' / ' + D.n], ['진척률', D.workPct + '%', '기간 시작 ' + D.workPctFrom + '%'], ['완료 예상일', dl(D.fc), '범위 ' + dm(D.lo) + ' ~ ' + dm(D.hi)], ['목표일 대비', slack == null ? '—' : (slack >= 0 ? '여유 ' + slack + '일' : (-slack) + '일 초과'), '목표 ' + dl(D.tgt)]]
// L4007
      : [['완료 (기간)', D.done.length + '건', '누적 ' + D.doneN + ' / ' + D.n], ['완료율 (작업량)', D.workPct + '%', '기간 시작 ' + D.workPctFrom + '%'], ['완료 예상 (v' + D.v + ')', dm(D.fc), '범위 ' + dm(D.lo) + ' ~ ' + dm(D.hi)], ['가동률', D.up + '%', D.gaps.length ? '중단 ' + D.gaps.length + '회' : '중단 없음']];
// L4008
    const cell = x => '<td style="padding:10px 12px;border:1px solid #E1E5EA;width:25%;vertical-align:top;' + F + '"><div style="font-size:12px;color:#6B7480">' + e(x[0]) + '</div><div style="font-size:20px;font-weight:700;color:#1F2933;margin:2px 0">' + e(x[1]) + '</div><div style="font-size:12px;color:#6B7480">' + e(x[2]) + '</div></td>';
// L4009
    const sec = (t, rows) => '<tr><td style="padding:18px 0 6px;' + F + 'font-size:15px;font-weight:700;color:#1F2933;border-bottom:1px solid #E1E5EA">' + e(t) + '</td></tr><tr><td style="padding:6px 0 0;' + F + 'font-size:13.5px;line-height:1.65;color:#3E4651">' + (rows.length ? rows.join('') : '<div style="color:#8A939E">없음</div>') + '</td></tr>';
// L4010
    const li = t => '<div style="padding:3px 0">• ' + e(t) + '</div>';
// L4011
    let body;
// L4012
    if (ext) {
// L4013
      const risks = []; if (slack != null && slack < 0) risks.push('목표일 초과 예상 — 범위 조정 또는 일정 협의 필요'); if (D.failN) risks.push('품질 보완 작업 ' + D.failN + '건 — 보완 후 재검증 예정'); if (D.blocked) risks.push('선행 작업 대기 ' + D.blocked + '건'); if (!risks.length) risks.push('특이 위험 없음');
// L4014
      body = sec('요약', ['기간 중 ' + D.done.length + '건 완료, 누적 ' + D.doneN + ' / ' + D.n + '건 (작업량 기준 ' + D.workPct + '%).', D.fc != null ? '완료 예상일 ' + dl(D.fc) + ' (범위 ' + dm(D.lo) + ' ~ ' + dm(D.hi) + ').' : '완료 예상일 산정 전.', D.failN ? '품질 검증 ' + D.failN + '건 보완 진행.' : '품질 검증 이상 없음.'].map(li))
// L4015
        + sec('주요 완료 항목', D.done.map(x => li(x.title))) + sec('위험 · 이슈', risks.map(li)) + sec('다음 계획', D.next.map(x => li(x.title + ' (' + dm(x.fs) + ' ~ ' + dm(x.fe) + ')')));
// L4016
    } else {
// L4017
      body = sec('팀장 확인 필요', D.issues.map(x => li(x.t))) + sec('완료한 Task', D.done.map(x => li(x.id + ' ' + x.title)))
// L4018
        + sec('진행 중 · 확인 필요', ((D.det && D.det.actDet) || []).slice(0, 6).map(x => li(x.id + ' ' + x.title + ' — ' + x.st + ' · 다음: ' + x.next)))
// L4019
        + sec('QA 실패', D.fails.map(x => li(x.task + ' ' + x.title + ' — ' + x.actual))) + sec('일정 재조정', D.rps.map(x => li(x.id + ' ' + x.trigger + ' (' + (x.before == null ? '최초' : dm(x.before)) + ' → ' + dm(x.after) + ')')))
// L4020
        + sec(r.kind === 'daily' ? '다음 날 예정' : '다음 주 예정', D.next.map(x => li(x.id + ' ' + x.title + ' (' + dm(x.fs) + ' ~ ' + dm(x.fe) + ')')));
// L4021
    }
// L4022
    return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>' + e(Sel.mailSubject(d, r, view)) + '</title></head>'
// L4023
      + '<body style="margin:0;padding:0;background:#F2F4F7"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F4F7"><tr><td align="center" style="padding:24px 12px">'
// L4024
      + '<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#FFFFFF;border:1px solid #E1E5EA;border-radius:8px"><tr><td style="padding:24px 28px">'
// L4025
      + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
// L4026
      + '<tr><td style="' + F + 'font-size:12px;font-weight:700;color:#2453CF">' + e({daily:'일간 보고서', weekly:'주간 보고서', custom:'기간 보고서'}[r.kind] + (ext ? ' · 보고용' : ' · 팀장용')) + '</td></tr>'
// L4027
      + '<tr><td style="' + F + 'font-size:20px;font-weight:700;color:#1F2933;padding:4px 0 2px">' + e(d.project.name) + '</td></tr>'
// L4028
      + '<tr><td style="' + F + 'font-size:13px;color:#6B7480;padding-bottom:14px;border-bottom:2px solid #1F2933">기간 ' + e(per) + ' · 생성 ' + e(r.at) + ' · ' + e(r.id) + '</td></tr>'
// L4029
      + '<tr><td style="padding:14px 0 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>' + kp.map(cell).join('') + '</tr></table></td></tr>'
// L4030
      + body
// L4031
      + ((d.appUrl || '').trim() ? '<tr><td style="padding:22px 0 0"><a href="' + e(d.appUrl.trim().replace(/\/$/, '')) + '/reports/' + e(r.id) + '" style="display:inline-block;padding:10px 16px;background:#2453CF;color:#FFFFFF;text-decoration:none;border-radius:6px;' + F + 'font-size:14px;font-weight:600">Agent WBS에서 전체 보고서 보기</a></td></tr>' : '')
// L4032
      + '<tr><td style="padding:18px 0 0;' + F + 'font-size:11.5px;color:#8A939E;line-height:1.6">이 메일은 Agent WBS가 보고서 생성 직후 자동으로 보냈습니다' + (to ? ' (수신: ' + e(to) + ')' : '') + '. 보고서는 생성 시점의 스냅샷이며 이후 변경은 반영되지 않습니다. 수신 설정은 Agent WBS → 설정 → 보고서 · 메일에서 바꿀 수 있습니다.</td></tr>'
// L4033
      + '</table></td></tr></table></td></tr></table></body></html>';
// L4034
  },
```
