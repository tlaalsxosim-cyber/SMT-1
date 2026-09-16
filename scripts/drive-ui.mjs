/**
 * 실제 브라우저로 앱을 조작해 4개 탭을 확인한다.
 * 설치된 Chrome을 그대로 쓴다 (playwright-core, 별도 브라우저 다운로드 없음).
 *
 *   node scripts/drive-ui.mjs
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = "tmp/shots";

mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log("·", ...a);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

try {
  // ── 1. 초기 진입 (데이터 업로드 탭)
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("text=AI 기반 일일 배송 최적화 시스템");
  log("헤더 렌더 OK");
  await page.screenshot({ path: `${OUT}/1-upload-empty.png` });

  // ── 2. 파일 2개 업로드
  const inputs = page.locator('input[type="file"]');
  await inputs.nth(0).setInputFiles("docs/출고등록현황.xlsx");
  await inputs.nth(1).setInputFiles("docs/차량 톤수.xlsx");
  await page.waitForTimeout(300);
  log("파일 2개 선택 OK");

  // ── 3. 파일 검증 · 미리보기
  await page.getByRole("button", { name: /파일 검증/ }).click();
  await page.waitForSelector("text=구조적 미배차 최소 13곳", { timeout: 30000 });
  log("FR-08 구조적 미배차 경고 표시됨");

  const metrics = await page.locator("main").innerText();
  for (const expect of ["8,043", "55곳", "12회전", "8,225", "42곳"]) {
    if (!metrics.includes(expect)) throw new Error(`요약 지표 누락: ${expect}`);
  }
  log("FR-07 파싱 요약 지표 OK (8,043박스 / 55곳 / 12회전 / 상한 8,225 / 업체수 42)");
  await page.screenshot({ path: `${OUT}/2-upload-preview.png`, fullPage: true });

  // ── 4. 담당자 확인 탭
  await page.getByRole("tab", { name: /담당자 확인/ }).click();
  await page.waitForTimeout(400);
  const review = await page.locator("main").innerText();
  if (!review.includes("지케이")) throw new Error("시간창 불일치 목록에 지케이가 없음");
  log("담당자 확인 목록 OK (시간창 불일치 · 조기납품 후보 · 배제 구간)");
  await page.screenshot({ path: `${OUT}/3-review.png`, fullPage: true });

  // ── 5. 차량 마스터 (읽기 전용)
  await page.getByRole("tab", { name: "차량 마스터" }).click();
  await page.waitForTimeout(300);
  const fleet = await page.locator("main").innerText();
  if (!fleet.includes("곽창훈기사님")) throw new Error("차량 마스터 표가 비어 있음");
  log("차량 마스터 표 OK");

  // ── 6. 배차 실행
  await page.getByRole("tab", { name: /조건 구조화/ }).click();
  await page.getByRole("button", { name: /배차 실행/ }).click();
  await page.waitForSelector("text=결과 엑셀 다운로드", { timeout: 120000 });
  log("배차 실행 완료 → 배차 보드 자동 전환");

  const board = await page.locator("main").innerText();
  const assigned = /배차\s*\n?\s*([\d,]+)\s*박스/.exec(board);
  log(`배차 결과: ${assigned ? assigned[1] : "?"} 박스`);
  if (!board.includes("제약 위반")) throw new Error("제약 위반 지표 없음");

  // ── 7. 지도 렌더 확인 — 웹 키가 있으면 jsv2 지도, 없거나 실패하면 SVG 폴백
  const tmapMap = page.locator('div[aria-label="배차 지도 (TMAP)"]');
  const svgMap = page.locator('svg[aria-label="배차 지도"]');
  const usingTmap = (await tmapMap.count()) > 0;
  let markerLocator;

  if (usingTmap) {
    // 부트스트랩 → 본체 → 네임스페이스까지 끝나야 오버레이가 걷힌다
    await page.waitForSelector("text=TMAP 지도 SDK를 불러오는 중…", {
      state: "detached",
      timeout: 60000,
    });
    // 마커 아이콘은 data URI SVG, 배경 타일은 일반 img — 둘을 나눠서 센다
    markerLocator = tmapMap.locator('img[src^="data:image/svg"]');
    await markerLocator.first().waitFor({ timeout: 30000 });
    // 타일이 다 그려지기 전에 찍으면 회색 배경(TMAP 워터마크)만 남는다
    await page.waitForFunction(
      () => {
        const root = document.querySelector('div[aria-label="배차 지도 (TMAP)"]');
        if (!root) return false;
        const imgs = [...root.querySelectorAll('img:not([src^="data:"])')];
        return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0);
      },
      null,
      { timeout: 30000 }
    );
    const markers = await markerLocator.count();
    const tiles = await tmapMap.locator('img:not([src^="data:"])').count();
    if (markers === 0) throw new Error("지도에 마커가 없음");
    // 타일이 0장이면 키·도메인 제한이거나 httpsMode 누락(Mixed Content 차단)이다
    if (tiles === 0) throw new Error("지도 타일이 한 장도 안 내려옴");
    log(`TMAP jsv2 지도 렌더 OK — 마커 ${markers}개, 타일 ${tiles}장`);
  } else {
    markerLocator = svgMap.locator("circle");
    const markers = await markerLocator.count();
    const polylines = await svgMap.locator("polyline").count();
    if (markers === 0) throw new Error("지도에 마커가 없음");
    log(`SVG 폴백 지도 렌더 OK — 마커 ${markers}개, 경로선 ${polylines}개`);
  }
  await page.screenshot({ path: `${OUT}/4-board.png`, fullPage: true });

  // ── 8. 회전 강조 (마커 클릭)
  await markerLocator.nth(1).click();
  await page.waitForTimeout(300);
  const focusVisible = await page.getByRole("button", { name: "전체 보기" }).isVisible();
  log(`회전 강조 인터랙션 ${focusVisible ? "OK" : "미동작"}`);
  await page.screenshot({ path: `${OUT}/5-board-focus.png` });
  if (focusVisible) await page.getByRole("button", { name: "전체 보기" }).click();

  // ── 9. 기타(미배차) 패널
  await page.getByRole("tab", { name: /기타\(미배차\)/ }).click();
  await page.waitForTimeout(400);
  const misc = await page.locator("main").innerText();
  if (!misc.includes("권역별")) throw new Error("기타 패널이 권역별로 묶이지 않음");
  log("기타(미배차) 권역별 패널 OK");
  await page.screenshot({ path: `${OUT}/6-unassigned.png`, fullPage: true });

  // ── 10. 설정 탭
  await page.getByRole("tab", { name: "설정" }).click();
  await page.waitForSelector("text=일일 API 호출 카운터");
  const settings = await page.locator("main").innerText();
  for (const expect of ["TMAP_APP_KEY", "ANTHROPIC_API_KEY", "경유지 최적화", "마감 ≤ 10:00"]) {
    if (!settings.includes(expect)) throw new Error(`설정 항목 누락: ${expect}`);
  }
  if (settings.includes("sk-") || settings.includes("appKey=")) {
    throw new Error("설정 화면에 키 값이 노출됨 (NFR-03 위반)");
  }
  log("설정 탭 OK — 키는 존재 여부만 표시, 값 노출 없음");
  await page.screenshot({ path: `${OUT}/7-settings.png`, fullPage: true });

  // ── 11. 다운로드 탭 + 실제 다운로드
  await page.getByRole("tab", { name: "결과 다운로드" }).click();
  await page.waitForSelector("text=아직 내려받지 않았습니다");
  log("FR-51 미다운로드 경고 표시됨");
  await page.screenshot({ path: `${OUT}/8-download.png`, fullPage: true });

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    page.getByRole("button", { name: /다운로드$/ }).click(),
  ]);
  const saved = `${OUT}/${download.suggestedFilename()}`;
  await download.saveAs(saved);
  log(`엑셀 다운로드 OK — ${download.suggestedFilename()}`);

  await page.waitForSelector("text=다운로드 완료", { timeout: 10000 });
  log("다운로드 완료 상태 전환 OK");
  await page.screenshot({ path: `${OUT}/9-downloaded.png`, fullPage: true });

  // ── 12. 무저장 확인 (NFR-01)
  const storage = await page.evaluate(() => ({
    local: Object.keys(localStorage).length,
    session: Object.keys(sessionStorage).length,
    idb: typeof indexedDB !== "undefined",
  }));
  if (storage.local > 0 || storage.session > 0) {
    throw new Error(
      `브라우저 저장소에 데이터가 남음 (local ${storage.local}, session ${storage.session}) — NFR-01 위반`
    );
  }
  log("NFR-01 OK — localStorage/sessionStorage 항목 0개");

  // ── 13. 새로고침 후 결과 소멸 확인
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "배차 보드" }).click();
  await page.waitForSelector("text=아직 배차 결과가 없습니다");
  log("새로고침 후 결과 소멸 확인 (의도된 무저장 동작)");

  console.log("\n콘솔 오류:", consoleErrors.length === 0 ? "없음" : consoleErrors);
  console.log(`스크린샷: ${OUT}/`);
  if (consoleErrors.length) process.exitCode = 1;
} catch (e) {
  console.error("\n실패:", e.message);
  await page.screenshot({ path: `${OUT}/FAIL.png`, fullPage: true }).catch(() => {});
  console.error("콘솔 오류:", consoleErrors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
