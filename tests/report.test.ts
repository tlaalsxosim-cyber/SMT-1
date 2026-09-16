/**
 * 배차 결과를 사람이 읽을 수 있게 출력한다 (테스트가 아니라 리포트).
 * `npx vitest run tests/report.test.ts`
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseFleet } from "@/lib/parse/fleet";
import { parseShipment } from "@/lib/parse/shipment";
import { runPipeline } from "@/lib/pipeline/run";
import { summarizeReasons } from "@/lib/dispatch/assign";
import { toHHMM, formatWindows } from "@/lib/structure/time-window";

describe("배차 결과 리포트", () => {
  it("Demo Mode 배차 결과", async () => {
    const ship = await parseShipment(readFileSync("docs/출고등록현황.xlsx"));
    const fleet = await parseFleet(readFileSync("docs/차량 톤수.xlsx"));
    const out = await runPipeline(ship, fleet, { demo: true, useAi: false });

    const L = (s = "") => console.log(s);
    const bar = (n = 92) => L("─".repeat(n));

    bar();
    L(`배차 결과  ${out.date}   (Demo Mode)`);
    bar();
    L(`총 물량      ${out.totalBoxes.toLocaleString()} 박스 / ${ship.points.length} 납품처`);
    L(`배차         ${out.assignedBoxes.toLocaleString()} 박스  (${((out.assignedBoxes / out.totalBoxes) * 100).toFixed(1)}%)`);
    L(`기타         ${out.unassignedBoxes.toLocaleString()} 박스  (${out.unassigned.length} 건)`);
    L(`사용 회전    ${out.usedTrips} / ${fleet.capacity.totalTrips}`);
    L(`제약 위반    ${out.violations.length} 건`);
    L(
      `총 주행      ${out.trips.reduce((s, t) => s + t.driveKm, 0).toFixed(0)} km` +
        `   공차 귀가 ${out.trips.reduce((s, t) => s + t.homeKm, 0).toFixed(0)} km`
    );

    bar();
    L("회전별 상세");
    bar();
    for (const t of out.trips.sort((a, b) => a.기사명.localeCompare(b.기사명) || a.tripNo - b.tripNo)) {
      const v = out.vehicles.find((x) => x.id === t.vehicleId)!;
      L(
        `${t.기사명} ${t.톤수라벨} ${t.tripNo}회전 · ${String(t.boxes).padStart(4)}박스 ` +
          `(적재율 ${(t.loadRate * 100).toFixed(0)}%, 하한 ${v.최소수량}) · ${t.stops.length}개사 · ` +
          `출발 ${toHHMM(t.departAt)} · 주행 ${t.driveKm.toFixed(0)}km · 귀가 ${t.homeKm.toFixed(0)}km`
      );
      for (const s of t.stops) {
        L(
          `    ${s.seq}. ${s.company.padEnd(20).slice(0, 20)} ${String(s.boxes).padStart(4)}박스  ` +
            `도착 ${s.arriveAt === null ? "  -  " : toHHMM(s.arriveAt)}  ` +
            `창 ${formatWindows(s.windows).padEnd(26)} ${s.timeOk === false ? "⚠ 위반" : ""}  ${s.tags.join(",")}`
        );
      }
    }

    bar();
    L("기타 (미배차) — 사유별 박스");
    bar();
    const reasons = summarizeReasons(out.unassigned);
    for (const [r, boxes] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
      L(`  ${r.padEnd(12)} ${String(boxes).padStart(5)} 박스`);
    }
    L();
    for (const u of [...out.unassigned].sort((a, b) => b.boxes - a.boxes)) {
      L(`  ${String(u.boxes).padStart(5)} ${u.company.padEnd(22).slice(0, 22)} ${u.region.padEnd(10).slice(0, 10)} [${u.reason}] ${u.note}`);
    }

    bar();
    L(`주소확인필요 ${out.addressIssues.length} 건`);
    bar();
    for (const a of out.addressIssues) {
      L(`  ${a.company} — ${a.failureType}: ${a.note}`);
    }

    expect(out.violations).toHaveLength(0);
  }, 120_000);
});
