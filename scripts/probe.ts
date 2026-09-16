/**
 * 실데이터 검증 프로브 — docs/ 의 실제 엑셀로 파서 정확도를 눈으로 확인한다.
 * `npm run probe`
 */
import { readFileSync } from "node:fs";
import { parseShipment } from "../src/lib/parse/shipment";
import { parseFleet } from "../src/lib/parse/fleet";
import { formatWindows } from "../src/lib/structure/time-window";

const SHIPMENT = "docs/출고등록현황.xlsx";
const FLEET = "docs/차량 톤수.xlsx";

function line(n = 78) {
  console.log("─".repeat(n));
}

async function main() {
  const ship = await parseShipment(readFileSync(SHIPMENT));
  const fleet = await parseFleet(readFileSync(FLEET));

  line();
  console.log("출고등록현황");
  line();
  console.log("출고일자      :", ship.date);
  console.log("총 행         :", ship.totalRows);
  console.log("배차 대상 행  :", ship.targetRows);
  console.log("제외 행       :", ship.excluded.length);
  const byReason = ship.excluded.reduce<Record<string, number>>((a, e) => {
    a[e.reason] = (a[e.reason] ?? 0) + 1;
    return a;
  }, {});
  console.log("제외 사유별   :", JSON.stringify(byReason));
  console.log("납품처        :", ship.points.length);
  console.log("총 박스       :", ship.totalBoxes.toLocaleString());

  line();
  console.log("차량 마스터");
  line();
  const c = fleet.capacity;
  console.log("기사          :", c.driverCount);
  console.log("총 회전       :", c.totalTrips);
  console.log("적재 상한     :", c.maxBoxes.toLocaleString());
  console.log("적재 하한     :", c.minBoxes.toLocaleString());
  console.log("업체 수 상한  :", c.maxCompanies);
  console.log("업체 수 하한  :", c.minCompanies);
  console.log(
    "구조적 미배차 :",
    Math.max(0, ship.points.length - c.maxCompanies),
    "곳 (납품처", ship.points.length, "> 업체수 상한", c.maxCompanies, ")"
  );

  line();
  console.log("시간창 해석 결과");
  line();
  const withWindow = ship.points.filter((p) => p.time.windows.length > 0);
  const colOnly = ship.points.filter((p) => p.time.fromColumn.length > 0);
  console.log("컬럼 보유     :", colOnly.length, "곳");
  console.log("최종 시간창   :", withWindow.length, "곳");
  const kinds = ship.points.reduce<Record<string, number>>((a, p) => {
    a[p.time.mismatch] = (a[p.time.mismatch] ?? 0) + 1;
    return a;
  }, {});
  console.log("대조 결과     :", JSON.stringify(kinds));

  line();
  console.log("경계 불일치 / 컬럼 결손 상세");
  line();
  for (const p of ship.points) {
    if (p.time.mismatch === "boundary" || p.time.mismatch === "missing") {
      console.log(`[${p.time.mismatch}] ${p.parsedName.company}`);
      console.log(`   원문   : ${p.parsedName.conditionText || "(없음)"}`);
      console.log(`   컬럼   : ${p.time.columnRaw ?? "(없음)"}`);
      console.log(`   채택   : ${formatWindows(p.time.windows)}  ← ${p.time.adopted}`);
    }
  }

  line();
  console.log("전체 납품처 시간창");
  line();
  for (const p of ship.points) {
    console.log(
      String(p.boxes).padStart(5),
      "|",
      p.parsedName.company.padEnd(22).slice(0, 22),
      "|",
      (p.parsedName.region || "-").padEnd(10).slice(0, 10),
      "|",
      formatWindows(p.time.windows).padEnd(28),
      "|",
      p.tags.join(",") || "-"
    );
  }

  line();
  console.log("검증 이슈");
  line();
  const lv = ship.issues.concat(fleet.issues).reduce<Record<string, number>>((a, i) => {
    a[i.level] = (a[i.level] ?? 0) + 1;
    return a;
  }, {});
  console.log("레벨별:", JSON.stringify(lv));
  for (const i of [...ship.issues, ...fleet.issues]) {
    if (i.level === "info") continue;
    console.log(`  [${i.level}/${i.code}] ${i.subject ?? ""} — ${i.message}`);
    if (i.detail) console.log(`       ${i.detail}`);
  }

  line();
  console.log("주소 정제 샘플");
  line();
  for (const p of ship.points.slice(0, 8)) {
    console.log("원문:", p.address);
    console.log("정제:", p.cleanAddress);
  }
  for (const v of fleet.vehicles) {
    console.log(`${v.기사명} 도착지: ${v.도착지}  →  ${v.cleanArrival}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
