/**
 * 파렛트 적재 기준 마스터 파서·계산 (R-19)
 *
 * `docs/평택센터_파렛트적재기준.xlsx`(현업 제공, 2026-09-23 수령)를 회귀 테스트 셋으로
 * 고정한다. 이 파일이 바뀌면 실측 수치를 고정한 테스트가 먼저 깨진다(acceptance.test.ts와
 * 같은 성격) — `npm run gen:pallet-spec`으로 스냅샷을 재생성한 뒤 여기 수치도 갱신한다.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { computePalletUsage } from "@/lib/domain/pallet";
import type { PalletSpec } from "@/lib/domain/types";
import { parsePalletMaster } from "@/lib/parse/pallet";
import { readSheet, readWorkbook, type SheetTable } from "@/lib/parse/workbook";

function table(rows: Record<string, string | number | null>[]): SheetTable {
  return {
    sheetName: "Sheet1",
    headers: ["품번", "품명", "N11", "N12"],
    rows,
    rowNos: rows.map((_, i) => i + 2),
  };
}

describe("parsePalletMaster", () => {
  it("품번·품명·N11·N12를 읽는다", () => {
    const t = table([{ 품번: "A001", 품명: "새우살", N11: 80, N12: null }]);
    const { specs } = parsePalletMaster(t);
    expect(specs).toEqual([{ 품번: "A001", 품명: "새우살", n11: 80, n12: null }]);
  });

  it("품번이 빈 행은 건너뛴다", () => {
    const t = table([
      { 품번: "", 품명: "소계", N11: null, N12: null },
      { 품번: "A001", 품명: "새우살", N11: 80, N12: null },
    ]);
    expect(parsePalletMaster(t).specs).toHaveLength(1);
  });

  it("N11/N12가 공백 문자열이면 0이 아니라 null로 본다 (실데이터 결함 대응)", () => {
    const t = table([{ 품번: "A001", 품명: "새우살", N11: " ", N12: 40 }]);
    const { specs } = parsePalletMaster(t);
    expect(specs[0].n11).toBeNull();
    expect(specs[0].n12).toBe(40);
  });

  it("N11/N12가 둘 다 없으면 info 이슈를 남긴다", () => {
    const t = table([{ 품번: "A001", 품명: "위탁매입품", N11: null, N12: null }]);
    const { issues } = parsePalletMaster(t);
    expect(issues.some((i) => i.level === "info" && i.subject === "A001")).toBe(true);
  });

  it("중복 품번은 첫 행만 채택하고 경고를 남긴다", () => {
    const t = table([
      { 품번: "A001", 품명: "첫번째", N11: 80, N12: null },
      { 품번: "A001", 품명: "두번째", N11: 40, N12: null },
    ]);
    const { specs, issues } = parsePalletMaster(t);
    expect(specs).toHaveLength(1);
    expect(specs[0].품명).toBe("첫번째");
    expect(issues.some((i) => i.level === "warning" && i.subject === "A001")).toBe(true);
  });

  it("필수 컬럼이 없으면 예외를 던진다", () => {
    expect(() =>
      parsePalletMaster({ sheetName: "Sheet1", headers: ["품번"], rows: [], rowNos: [] })
    ).toThrow(/품명/);
  });
});

describe("computePalletUsage", () => {
  const specBy: Record<string, PalletSpec> = {
    A001: { 품번: "A001", 품명: "새우살", n11: 80, n12: 40 },
    B002: { 품번: "B002", 품명: "닭가슴살", n11: null, n12: 60 },
    C003: { 품번: "C003", 품명: "미확인품목", n11: null, n12: null },
  };

  it("품목별로 올림 나눗셈한 뒤 더한다 (박스 합계를 평균으로 나누지 않는다)", () => {
    // A001: 100박스 / 80 → 2파렛트, B002는 없음 → N12로 폴백 60박스/60 → 1파렛트
    const r = computePalletUsage(
      [
        { 품번: "A001", boxes: 100 },
        { 품번: "B002", boxes: 60 },
      ],
      specBy
    );
    expect(r.count).toBe(3);
    expect(r.unresolved).toEqual([]);
  });

  it("기본 유형에 값이 없으면 다른 유형으로 폴백한다", () => {
    const r = computePalletUsage([{ 품번: "B002", boxes: 61 }], specBy, "N11");
    expect(r.count).toBe(2); // N12 기준 60개/파렛트 → ceil(61/60)=2
  });

  it("품번을 못 찾거나 두 유형 다 없으면 전체를 null(미상)로 둔다", () => {
    const r1 = computePalletUsage([{ 품번: "없는품번", boxes: 10 }], specBy);
    expect(r1.count).toBeNull();
    expect(r1.unresolved).toEqual(["없는품번"]);

    const r2 = computePalletUsage(
      [
        { 품번: "A001", boxes: 80 },
        { 품번: "C003", boxes: 10 },
      ],
      specBy
    );
    expect(r2.count).toBeNull();
    expect(r2.unresolved).toEqual(["C003"]);
  });

  it("품목이 없으면 null이다", () => {
    expect(computePalletUsage([], specBy).count).toBeNull();
  });
});

describe("실데이터 — 평택센터_파렛트적재기준.xlsx (2026-09-23 수령)", () => {
  it("340행 / 고유 품번 336개, N11 276건 · N12 43건", async () => {
    const buf = readFileSync("docs/평택센터_파렛트적재기준.xlsx");
    const wb = await readWorkbook(buf);
    const t = readSheet(wb);
    const { specs } = parsePalletMaster(t);

    expect(t.rows.length).toBe(340);
    expect(specs).toHaveLength(336);
    expect(specs.filter((s) => s.n11 !== null)).toHaveLength(276);
    expect(specs.filter((s) => s.n12 !== null)).toHaveLength(43);
  });
});
