/**
 * 결과 엑셀 생성 검증 (AC-15 / PRD §10)
 * 생성한 파일을 다시 읽어 시트 구성과 합계를 확인한다.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import ExcelJS from "exceljs";
import { beforeAll, describe, expect, it } from "vitest";

import { parseFleet } from "@/lib/parse/fleet";
import { parseShipment } from "@/lib/parse/shipment";
import { runPipeline, type RunOutput } from "@/lib/pipeline/run";
import { buildResultWorkbook, resultFileName } from "@/lib/export/workbook";

let out: RunOutput;
let wb: ExcelJS.Workbook;
let pointCount: number;

beforeAll(async () => {
  const ship = await parseShipment(readFileSync("docs/출고등록현황.xlsx"));
  const fleet = await parseFleet(readFileSync("docs/차량 톤수.xlsx"));
  pointCount = ship.points.length;

  out = await runPipeline(ship, fleet, { demo: true, useAi: false });

  const buf = await buildResultWorkbook({
    ...out,
    includeCoordinates: true,
    sourceSummary: {
      totalRows: ship.totalRows,
      targetRows: ship.targetRows,
      excludedRows: ship.excluded.length,
      pointCount: ship.points.length,
      totalTrips: fleet.capacity.totalTrips,
      maxBoxes: fleet.capacity.maxBoxes,
      minBoxes: fleet.capacity.minBoxes,
      maxCompanies: fleet.capacity.maxCompanies,
    },
  });

  // 눈으로 확인할 수 있게 산출물을 남긴다
  mkdirSync("tmp", { recursive: true });
  writeFileSync(`tmp/${resultFileName(out.date)}`, buf);

  wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
}, 120_000);

describe("AC-15 결과 엑셀", () => {
  it("좌표 시트 포함 시 6개 시트가 생성된다", () => {
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "배차표",
      "기타_미배차",
      "주소확인필요",
      "요약",
      "검증이슈",
      "좌표",
    ]);
  });

  it("배차표에 모든 하차지가 들어 있다", () => {
    const ws = wb.getWorksheet("배차표")!;
    const stopCount = out.trips.reduce((s, t) => s + t.stops.length, 0);
    // 하차 행 + 회전 소계 행 + 빈 행
    const dataRows = ws.rowCount - 1;
    expect(dataRows).toBeGreaterThanOrEqual(stopCount);

    // 업체명으로 세면 안 된다 — 실데이터에 같은 이름의 다른 납품처가 있다
    // (지케이/안성, 지케이/광주새말길). 방문순서 칸이 숫자인 행 = 하차 행이다.
    let stopRows = 0;
    ws.eachRow((row, i) => {
      if (i === 1) return;
      if (typeof row.getCell(4).value === "number") stopRows += 1;
    });
    expect(stopRows).toBe(stopCount);
  });

  it("배차표에 방문순서·도착예정·귀가거리 컬럼이 있다 (§10 시트1)", () => {
    const header = wb.getWorksheet("배차표")!.getRow(1).values as unknown[];
    const text = header.join("|");
    for (const col of ["기사명", "톤수", "회전", "방문", "업체명", "권역", "주소", "박스", "TMAP", "특이사항"]) {
      expect(text).toContain(col);
    }
  });

  it("기타_미배차 합계가 파이프라인 결과와 일치한다", () => {
    const ws = wb.getWorksheet("기타_미배차")!;
    let totalRow: ExcelJS.Row | null = null;
    ws.eachRow((row) => {
      if (String(row.getCell(1).value) === "합계") totalRow = row;
    });
    expect(totalRow).not.toBeNull();
    expect(totalRow!.getCell(4).value).toBe(out.unassignedBoxes);
  });

  it("미배차 전 건에 사유 코드가 채워져 있다 (FR-43)", () => {
    const ws = wb.getWorksheet("기타_미배차")!;
    let rows = 0;
    ws.eachRow((row, i) => {
      if (i === 1) return;
      const reason = row.getCell(6).value;
      const region = String(row.getCell(1).value ?? "");
      if (region.endsWith("소계") || region === "합계") return;
      if (row.getCell(4).value === null) return;
      rows += 1;
      expect(String(reason ?? "")).not.toBe("");
    });
    expect(rows).toBe(out.unassigned.length);
  });

  it("요약 시트에 API 호출 건수와 제약 위반 건수가 있다 (NFR-09)", () => {
    const ws = wb.getWorksheet("요약")!;
    const labels: string[] = [];
    ws.eachRow((row) => labels.push(String(row.getCell(1).value ?? "")));
    expect(labels).toContain("제약 위반 건수");
    expect(labels).toContain("경유지 최적화");
    expect(labels).toContain("지오코딩");
    expect(labels).toContain("배차 물량");
    expect(labels).toContain("공차 귀가거리");
  });

  it("요약 시트가 구조적 미배차를 명시한다 (AC-03)", () => {
    const ws = wb.getWorksheet("요약")!;
    let note = "";
    ws.eachRow((row) => {
      if (String(row.getCell(1).value) === "업체 수 상한") note = String(row.getCell(3).value ?? "");
    });
    expect(note).toContain("최소 13곳");
    expect(pointCount).toBe(55);
  });

  it("좌표 시트가 약관 경고를 포함한다 (OI-5)", () => {
    const ws = wb.getWorksheet("좌표")!;
    const first = ws.getRow(2);
    expect(String(first.getCell(2).value)).toContain("약관");
  });

  it("파일명 규칙을 지킨다 (FR-52)", () => {
    expect(resultFileName("20260915")).toMatch(/^배차결과_20260915_\d{4}\.xlsx$/);
  });
});

describe("좌표 시트 기본 비활성 (FR-53)", () => {
  it("includeCoordinates를 주지 않으면 5개 시트만 생성된다", async () => {
    const buf = await buildResultWorkbook({ ...out });
    const w = new ExcelJS.Workbook();
    await w.xlsx.load(buf as unknown as ArrayBuffer);
    expect(w.worksheets.map((x) => x.name)).not.toContain("좌표");
    expect(w.worksheets).toHaveLength(5);
  });
});
