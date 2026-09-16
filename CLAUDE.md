# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

---

한국 물류 배차 도메인 앱입니다. **코드 주석·UI·커밋 메시지는 한국어로 작성**하고, 도메인 용어(납품처·회전·권역·기타·조기납품)를 그대로 씁니다.

## 명령어

```bash
npm run dev          # 개발 서버 (localhost:3000)
npm run build        # 프로덕션 빌드
npm test             # 전체 테스트
npm run test:watch   # 감시 모드
npm run typecheck    # tsc --noEmit
npm run lint         # eslint

npx vitest run tests/pipeline.test.ts                        # 파일 하나
npx vitest run tests/time-window.test.ts -t "배제 구간"       # 이름으로 필터
npm run report       # 배차 결과를 사람이 읽는 표로 출력 (테스트 아님)
npm run probe        # 파서 결과를 실데이터로 덤프
npm run compare      # 미확정 기준값이 배차 결과를 얼마나 바꾸는지 측정
npm run start-check  # 납품 시작 시각 적용 결과 (등록값 유지 / 누락분 08:00)
npm run drive-ui     # 설치된 Chrome으로 4개 탭 E2E 구동 + 스크린샷 (서버가 떠 있어야 함)
```

`npm run report`는 `--disable-console-intercept`가 필요합니다. 이 플래그가 없으면 vitest가
`console.log`를 삼켜 아무것도 안 나옵니다.

### 테스트는 계층이 다릅니다

새 규칙을 넣을 때 **어느 파일에 고정할지**가 정해져 있습니다.

| 파일 | 무엇을 고정하는가 |
|---|---|
| `acceptance.test.ts` | 실엑셀 **파싱 결과**를 숫자로 못 박음. 배차 결과는 다루지 않습니다 |
| `pipeline.test.ts` | Demo Mode E2E — "지금 이 데이터에서 규칙이 지켜졌다" |
| `dispatch-rules.test.ts` | **합성 데이터로 규칙 자체**를 고정 — 데이터가 바뀌어도 규칙은 그대로여야 합니다 |
| `time-window.test.ts` | 시간창 파서 단위 |
| `export.test.ts` | 결과 엑셀 시트 구성·합계 |
| `tmap-sdk.test.ts` | jsv2 로더 (DOM 없이 순수 함수만) |
| `report.test.ts` | 테스트가 아니라 사람이 읽는 출력 (`npm run report`) |

배차 규칙을 바꾸면 **`dispatch-rules`(규칙)와 `pipeline`(실데이터) 양쪽**에 넣으십시오.
실데이터 쪽만 고치면 규칙이 아니라 우연을 고정하게 됩니다.

## 사양 문서가 곧 사양입니다

- `docs/PRD.md` — 요구사항 명세. 코드 전반의 `FR-xx`(기능) / `R-xx`(배차 규칙) / `AC-xx`(수용 기준) / `OI-x`(미확정 이슈) 주석은 **모두 이 문서의 절 번호**를 가리킵니다.
- `docs/plan.md` — 원본 기획서
- `docs/출고등록현황.xlsx`, `docs/차량 톤수.xlsx` — 2026-09-15 실데이터. **테스트가 이 파일을 직접 읽습니다.** 파일을 바꾸면 `tests/acceptance.test.ts`가 먼저 깨지며, 이는 의도된 동작입니다.

규칙을 바꿀 때는 코드·`docs/PRD.md`·`README.md`·설정 탭 문구를 **함께** 고쳐야 합니다.
넷 중 하나만 고치면 문서와 동작이 어긋납니다(실제로 그런 적이 있습니다).

## 아키텍처

PRD §9의 3계층 분리를 디렉터리 구조로 그대로 옮겼습니다. 이 경계를 흐리지 마십시오.

| 계층 | 책임 | 위치 |
|---|---|---|
| ① 생성형 AI | 비정형 텍스트 해석 **보완** | `src/lib/structure/llm.ts`, `enrich.ts` |
| ② 자체 로직 | **차량 간 배분** (어느 차가 어디를) | `src/lib/dispatch/` |
| ③ TMAP | 좌표 · 차량 1대 내 방문순서 · 실도로 경로 | `src/lib/tmap/` |

`src/lib/pipeline/run.ts`가 세 계층을 순서대로 엮는 유일한 오케스트레이터입니다.

```
[1] 파싱·검증 → [2] 조건 구조화 → [3] 좌표 변환 → [4] 차량 간 배분
  → [5] 방문순서 최적화 → [6] 시간 검증(위반 시 [4] 복귀, 재시도 1회) → [7] 경로 확정 → [8] 출력
```

### 규칙 파서가 먼저, AI는 보완

AI가 규칙 파서를 대체하지 않습니다. 규칙만으로 실데이터 55곳 중 45곳의 시간창을 확보하고,
AI에는 **규칙이 해석하지 못했거나 두 소스가 어긋난 건만** 보냅니다(`enrich.ts`의 `selectForAi`).
AI 출력은 구조화 JSON으로 받아 `validateWindows` 검증을 통과해야 배차에 반영되며,
확신도가 낮으면 담당자 확인 목록으로만 보냅니다. 키가 없으면 이 단계를 통째로 건너뜁니다.

### 무저장(stateless) 구조 — 타협 불가

DB·ORM·파일 저장소가 없고, `localStorage`/`sessionStorage`/IndexedDB도 쓰지 않습니다.
서버는 요청 처리 중에만 메모리에 들고 응답 후 버립니다. 새로고침하면 결과가 사라지는 것이
**의도된 동작**이며, `beforeunload` 경고로 담당자에게 알립니다.

서버가 세션을 들지 않으므로 **클라이언트가 업로드 파일 원본을 메모리에 쥐고 매 요청에 다시
실어 보냅니다**(`src/lib/store.ts` → `src/lib/api/contracts.ts` → `src/app/api/*`).
서버에 "직전 업로드"를 캐시하고 싶어지면 그건 무저장 구조를 깨는 것입니다.
`npm run drive-ui`가 브라우저 저장소 항목이 0개인지 검증합니다.

예외는 `src/lib/tmap/counter.ts`의 API 호출 카운터 하나뿐입니다. 서버 프로세스 메모리에만
있고 재시작하면 0으로 돌아가며, 화면에 그 사실을 명시합니다.

### 거리 계산의 단일 진입점

`src/lib/dispatch/distance.ts`의 `distKm`이 전부입니다. 조합 탐색은 수천 번 돌기 때문에
**루프 안에서 TMAP을 부르면 무료 한도가 즉시 소진됩니다.** 1차 후보 선정은 직선거리 근사,
최종 검증·표시만 TMAP 실도로 값으로 덮어씁니다.

### TMAP API 예산 — 가장 귀한 자원

경유지 최적화는 **하루 50건**이 전부입니다. 보호 장치가 겹쳐 있으니 하나도 빼지 마십시오.

- **Demo Mode가 기본값** (`src/lib/tmap/demo.ts`) — API를 전혀 부르지 않고 전 과정 재현.
  좌표는 시·군 중심점 + 주소 해시 기반 **결정적** 산포라 같은 입력이면 같은 결과가 나옵니다.
- 회전당 최적화 1회, 재시도 1회 한도
- `assertOptimizeBudget` — 안전 상한 24건/일, 무료 한도 50건에서 차단
- **서버 측 실행 잠금** (`acquireLock`) — 버튼 연타·새로고침 연타를 409로 거부.
  클라이언트 버튼 비활성화만 믿으면 안 됩니다.

### 서버/클라이언트 경계

`src/lib/tmap/client.ts`와 `src/lib/pipeline/run.ts`는 `import "server-only"`로 잠겨 있습니다
(TMAP 키 유출·CORS 방지). 테스트에서는 `vitest.config.mts`가 `tests/stubs/server-only.ts`로
치환하고, `scripts/`는 `tsconfig.scripts.json`의 path 매핑으로 우회합니다.
이 모듈을 클라이언트 컴포넌트에서 import하지 마십시오.

## 밟기 쉬운 함정들

**좌표 순서** — TMAP 요청 Body는 `X=경도, Y=위도`, 응답 LineString은 `[경도, 위도]`입니다.
`client.ts`가 이미 `[위도, 경도]`로 뒤집어 두므로 **내부 데이터는 전부 `[위도, 경도]`**입니다.
`tests/pipeline.test.ts`가 경로선 좌표의 대한민국 범위를 검사해 반전 실수를 잡습니다.

**`startTime`은 `yyyyMMddHHmm` 12자리** — 축약하면 400이 떨어집니다.

**TMAP `arriveTime`은 주행 시간만 계산합니다** — 시간창이 열리기 전 도착하면 기사는 기다렸다
하차하고 이후 배송지가 밀립니다. `src/lib/dispatch/waiting.ts`의 `applyWaiting`이 이 보정을
합니다. 빼면 "일찍 도착"이 시간창 위반으로 잡혀 멀쩡한 배송지가 무더기로 기타로 빠집니다.

**`earliestDeadline` vs `latestDeadline`** — 점심으로 나뉜 시간창에서 전자는 첫 구간 종료,
후자는 실질 마감입니다. R-15(2회전 마감 하한) 판정에는 **반드시 `latestDeadline`**을 쓰십시오.

**납품처 식별** — `납품처코드` 컬럼은 `1`, `2`, `01` 같은 중복·비정규 값이라 식별자로 쓸 수
없습니다. `납품처명 + 주소`로 그룹핑합니다(`pointKey`). 업체명도 유일하지 않습니다 —
실데이터에 `지케이`가 권역이 다른 두 곳 있으니 업체명으로 중복 제거하지 마십시오.

**박스 수량은 `재고단위수량`** — `출고수량`은 낱개(BAG/KG) 단위라 적재 계산에 쓰면 안 됩니다.

**R-18은 점수가 아니라 제외입니다** — 천안 이남(위도 36.9 미만)은 `assignDispatch` 전처리에서
풀 자체에서 빠집니다. 점수 벌점으로 미루면 북쪽에 대안이 없을 때 그대로 배차됩니다
(실데이터가 정확히 그랬습니다 — 익산 1,200 · 청주 1,061). **R-06 분할보다 먼저** 적용해야
남쪽 대형 건이 쪼개지지 않고 기타에 한 줄로 남습니다.

**`최대업체수`만 보고 대형차에 두 업체를 묶지 마십시오** — 5·10톤의 `최대업체수 2`는 **같은 건물에
업체가 둘일 때의 상한**입니다(R-17). 2번째 업체는 `siteKey`로 판정한 주소가 첫 업체와 같을 때만
붙습니다. 이 구분이 없으면 30박스짜리가 1,000박스짜리에 얹혀 10톤 차로 나갑니다.

**미배차 사유는 「빈 회전이 무엇인가」로 가릅니다** — `assign.ts`의 `diagnose`가
남은 공차 슬롯을 보고 `시간창불가`/`대형차단독`/`업체수상한`/`회전초과`를 구분합니다.
배차를 막는 규칙을 새로 넣으면 **여기도 같이 고쳐야** 합니다. 안 고치면 전부 "회전초과"로
뭉뚱그려져 담당자가 "차는 놀고 있는데 왜?"라고 되묻게 되고, 그 순간 결과 신뢰를 잃습니다.

**jsv2 SDK 준비 판정** — `window.Tmapv2` 존재만으로 판단하면 `LatLng is not a constructor`가
납니다. 네임스페이스가 비동기로 채워지므로 `isTmapReady`로 **필요한 생성자가 전부 함수인지**
확인해야 합니다.

**jsv2는 `document.write`로 본체를 끌어옵니다** — `apis.openapi.sk.com/tmap/jsv2`가 주는 건
1KB짜리 부트스트랩이고, 실제 SDK(`tmapjs2.min.js`)는 그 안에서 `document.write`로 붙습니다.
문서 파싱이 끝난 뒤 동적으로 추가한 스크립트의 `document.write`는 브라우저가 무시하므로
(`Failed to execute 'write' on 'Document'`), 그냥 `<script>`를 붙이면 `_getScriptLocation`만
올라온 채 영영 준비되지 않습니다. `tmap-sdk.ts`가 `document.write`를 잠깐 가로채 본체를 직접
붙입니다. **부트스트랩 `<script>` 태그는 지우지 마십시오** — SDK가 문서의 모든 `<script src>`를
훑어 `appKey=`를 뽑아 씁니다.

**지도 `httpsMode: true`** — jsv2 타일 기본 프로토콜이 http라 HTTPS 배포에서 Mixed Content로
전부 차단됩니다. `new Tmapv2.Map` 옵션에 반드시 넣으십시오(`map-view.tsx`).

## 미확정 사항 (OI)

`docs/PRD.md` §14에 정리돼 있습니다. 확정된 것과 아닌 것을 섞지 마십시오.

**확정** — R-15 2회전 마감 하한 **15:00**(상수, 화면 변경 불가) · R-16 납품 시작 시각
(**등록값은 그대로, 누락분만 08:00**) · OI-9 마지막 회전만 기사 거주지 도착(앞 회전은 센터 복귀·재상차) ·
OI-10 조기납품은 **한 기사당 1곳** 제한 하나뿐(회전 번호는 제약이 아님) ·
R-17 대형차(5톤 이상) **회전당 1업체**(2번째는 주소가 거의 동일할 때만) ·
R-18 **천안 이남은 지입 배차에서 제외**(후순위가 아니라 제외 — 용차로 넘김)

**미확정** — OI-1 코스코드 의미 · OI-2 조기납품 기준값 · OI-5 좌표 시트 재사용 · OI-7 출발 시각 ·
OI-8 재상차 30분 · OI-12 업체별 진입 가능 최대 톤수 마스터 ·
OI-13 기사별 배차 희망 권역(차량 마스터에 컬럼 추가 예정)

기준값을 바꿔 보려면 `npm run compare`로 배차량 영향을 먼저 측정하십시오.

## 검증되지 않은 부분

**TMAP REST API를 운영 키로 실호출한 적이 없습니다.** 배차는 전부 Demo Mode로 검증했습니다.
실키 전환 시 지오코딩 응답 필드 분기(`newLat`/`lat`)와 `routeOptimization10`의 `B1` 순서가
문서대로인지 확인이 필요합니다.

jsv2 지도는 2026-09-16에 실제 웹 키로 렌더를 확인했습니다 — `npm run drive-ui`가 타일과 마커가
실제로 그려졌는지, 콘솔 오류가 0건인지 검사합니다. (장수는 배차 결과에 따라 달라지므로
이 문서에 고정 수치를 적지 마십시오.)
