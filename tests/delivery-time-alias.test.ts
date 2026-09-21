/**
 * FR-11 확장 — `납품처메일주소` 컬럼을 `납품시간` 별칭으로 인식 (2026-09-21)
 *
 * ERP 원본 최신판은 `납품시간` 컬럼이 없고, 같은 자리를 `납품처메일주소`가 대신한다.
 * 컬럼명만 바뀌었을 뿐 값은 여전히 시간창 문자열이다("~12:00" 등) — 실데이터
 * 336행 전량에 실제 이메일 형식이 하나도 없음을 확인했다.
 */
import { describe, expect, it } from "vitest";

import { buildShipmentResult } from "@/lib/parse/shipment";
import type { SheetTable } from "@/lib/parse/workbook";

const REQUIRED = ["출고일자", "납품처", "납품처주소", "배송방법", "재고단위수량"];

function row(over: Partial<Record<string, string | number | null>> = {}) {
  return {
    출고일자: "20260921",
    납품처: "테스트업체",
    납품처주소: "경기도 용인시 처인구 1",
    배송방법: null,
    재고단위수량: 100,
    ...over,
  };
}

function table(headers: string[], rows: ReturnType<typeof row>[]): SheetTable {
  return {
    sheetName: "Sheet1",
    headers,
    rows: rows as SheetTable["rows"],
    rowNos: rows.map((_, i) => i + 2),
  };
}

describe("납품처메일주소 → 납품시간 별칭", () => {
  it("납품시간 컬럼이 없고 납품처메일주소만 있으면 그 값을 납품시간으로 쓴다", () => {
    const t = table(
      [...REQUIRED, "납품처메일주소"],
      [row({ 납품처메일주소: "8:00~9:30" })]
    );
    const r = buildShipmentResult(t);
    expect(r.points).toHaveLength(1);
    expect(r.points[0].time.windows).toEqual([{ start: 8 * 60, end: 9 * 60 + 30 }]);
    expect(r.issues.some((i) => i.level === "info" && i.message.includes("납품처메일주소"))).toBe(
      true
    );
  });

  it("납품시간 컬럼이 이미 있으면 별칭을 쓰지 않고 그 컬럼을 그대로 쓴다", () => {
    const t = table(
      [...REQUIRED, "납품시간", "납품처메일주소"],
      [row({ 납품시간: "10:00~14:00", 납품처메일주소: "이것은다른값@무시됨" })]
    );
    const r = buildShipmentResult(t);
    expect(r.points[0].time.windows).toEqual([{ start: 10 * 60, end: 14 * 60 }]);
    expect(r.issues.some((i) => i.message.includes("납품처메일주소"))).toBe(false);
  });

  it("둘 다 없으면 기존 그대로 필수 컬럼 오류를 낸다 (FR-02, 동작 변경 없음)", () => {
    const t = table(REQUIRED, [row()]);
    expect(() => buildShipmentResult(t)).toThrow(/납품시간/);
  });
});
