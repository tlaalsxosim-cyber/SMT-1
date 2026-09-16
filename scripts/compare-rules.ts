/**
 * 미확정 기준값이 배차 결과를 얼마나 바꾸는지 비교한다.
 *   - R-15 2회전 마감 하한: 14:00 / 15:00
 *   - R-08 조기납품 판정:   마감≤09:00 / 마감≤10:00 / 시작≤09:00
 *
 *   npx tsx scripts/compare-rules.ts
 */
import { readFileSync } from "node:fs";

import type { EarlyDeliveryMode } from "../src/lib/domain/constants";
import { parseFleet } from "../src/lib/parse/fleet";
import { parseShipment } from "../src/lib/parse/shipment";
import { runPipeline } from "../src/lib/pipeline/run";
import { SECOND_TRIP_MIN_DEADLINE } from "../src/lib/domain/constants";
import { toHHMM } from "../src/lib/structure/time-window";

async function main() {
  const ship = await parseShipment(readFileSync("docs/출고등록현황.xlsx"));
  const fleet = await parseFleet(readFileSync("docs/차량 톤수.xlsx"));

  const run = async (earlyMode: EarlyDeliveryMode, deadline: number) => {
    const out = await runPipeline(ship, fleet, {
      demo: true,
      useAi: false,
      drawRoutes: false,
      earlyMode,
      secondTripMinDeadline: deadline,
    });
    const secondTrips = out.trips.filter((t) => t.tripNo > 1);
    return {
      배차: out.assignedBoxes,
      기타: out.unassignedBoxes,
      회전: out.usedTrips,
      "2회전": secondTrips.length,
      "2회전 박스": secondTrips.reduce((s, t) => s + t.boxes, 0),
      위반: out.violations.length,
    };
  };

  const header = (t: string) => console.log(`\n${t}\n${"─".repeat(76)}`);
  const row = (label: string, r: Record<string, number>, total: number) =>
    console.log(
      `  ${label.padEnd(26)} 배차 ${String(r.배차).padStart(5)} (${((r.배차 / total) * 100).toFixed(1).padStart(5)}%) · ` +
        `기타 ${String(r.기타).padStart(5)} · 회전 ${r.회전} · 2회전 ${r["2회전"]}개(${r["2회전 박스"]}박스) · 위반 ${r.위반}`
    );

  header("R-15 · 2회전 납품 마감 하한 — 15:00 확정 (나머지는 참고 측정)");
  for (const d of [13 * 60, 14 * 60, SECOND_TRIP_MIN_DEADLINE]) {
    const mark = d === SECOND_TRIP_MIN_DEADLINE ? "  ← 확정" : "";
    row(`마감 ${toHHMM(d)} 이후만${mark}`, await run("endBy10", d), ship.totalBoxes);
  }

  header("R-08 · 조기납품 판정 기준 (2회전 하한은 확정값 15:00 고정)");
  for (const m of ["endBy9", "endBy10", "startBy9"] as EarlyDeliveryMode[]) {
    const label = { endBy9: "마감 ≤ 09:00", endBy10: "마감 ≤ 10:00", startBy9: "시작 ≤ 09:00" }[m];
    row(label, await run(m, SECOND_TRIP_MIN_DEADLINE), ship.totalBoxes);
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
