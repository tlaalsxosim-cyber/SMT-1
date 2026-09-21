/**
 * FR-54 — 출고장소코드(BA열) 파싱 + 출고 창고 주소지 반영
 *
 * 현업 요청(2026-09-21): BA열을 구분해서 반영하고, 출고 창고 주소지는
 * "등록된 내용만 반영, 안 된 건 미반영"한다. 등록된 주소가 여러 곳으로
 * 갈리면(다중 출발지) 지금 구조는 지원하지 않으니 자동 반영을 포기해야 한다.
 */
import { describe, expect, it } from "vitest";

import { buildShipmentResult } from "@/lib/parse/shipment";
import type { SheetTable } from "@/lib/parse/workbook";
import { deriveShipmentOrigin, WAREHOUSE_ADDRESS_BY_SITE_CODE } from "@/lib/parse/warehouse-address";

const BASE_HEADERS = [
  "출고일자",
  "납품처",
  "납품처주소",
  "납품시간",
  "배송방법",
  "재고단위수량",
  "출고장소코드",
  "출고장소",
];

function row(over: Partial<Record<string, string | number | null>> = {}) {
  return {
    출고일자: "20260915",
    납품처: "테스트업체",
    납품처주소: "경기도 용인시 처인구 1",
    납품시간: "13시착",
    배송방법: null,
    재고단위수량: 100,
    출고장소코드: "2800",
    출고장소: "평택센타",
    ...over,
  };
}

function table(rows: ReturnType<typeof row>[]): SheetTable {
  return {
    sheetName: "Sheet1",
    headers: BASE_HEADERS,
    rows: rows as SheetTable["rows"],
    rowNos: rows.map((_, i) => i + 2),
  };
}

describe("shipment 파서 — 출고장소코드(BA열) 인식", () => {
  it("BA열이 있으면 DeliveryPoint에 출고장소코드/출고장소를 채운다", () => {
    const r = buildShipmentResult(table([row()]));
    expect(r.points).toHaveLength(1);
    expect(r.points[0].출고장소코드).toBe("2800");
    expect(r.points[0].출고장소).toBe("평택센타");
  });

  it("BA열이 없는 구 양식 파일이면 null이고 에러가 나지 않는다", () => {
    const noBaHeaders = BASE_HEADERS.filter((h) => h !== "출고장소코드" && h !== "출고장소");
    const withoutBa: Record<string, unknown> = { ...row() };
    delete withoutBa.출고장소코드;
    delete withoutBa.출고장소;
    const t: SheetTable = {
      sheetName: "Sheet1",
      headers: noBaHeaders,
      rows: [withoutBa] as SheetTable["rows"],
      rowNos: [2],
    };
    const r = buildShipmentResult(t);
    expect(r.points).toHaveLength(1);
    expect(r.points[0].출고장소코드).toBeNull();
  });

  it("같은 납품처 안에서 출고장소코드가 갈리면 경고하고 첫 값을 쓴다", () => {
    const r = buildShipmentResult(
      table([row({ 재고단위수량: 60 }), row({ 재고단위수량: 40, 출고장소코드: "2200", 출고장소: "일죽창고" })])
    );
    expect(r.points).toHaveLength(1);
    expect(r.points[0].boxes).toBe(100);
    expect(r.points[0].출고장소코드).toBe("2800");
    expect(r.issues.some((i) => i.code === "FR-54")).toBe(true);
  });
});

describe("FR-54 — deriveShipmentOrigin (출고 창고 주소지 반영)", () => {
  it("등록된 출고장소코드 하나로 좁혀지면 그 주소를 반환한다", () => {
    const out = deriveShipmentOrigin([{ 출고장소코드: "2800" }, { 출고장소코드: "2800" }]);
    expect(out.address).toBe(WAREHOUSE_ADDRESS_BY_SITE_CODE["2800"].address);
    expect(out.issues).toHaveLength(0);
  });

  it("BA열이 전부 비어 있으면(구 양식) 아무것도 반영하지 않는다", () => {
    const out = deriveShipmentOrigin([{ 출고장소코드: null }, {}]);
    expect(out.address).toBeNull();
    expect(out.issues).toHaveLength(0);
  });

  it("미등록 코드만 있으면 반영하지 않고 정보성 안내만 남긴다", () => {
    const out = deriveShipmentOrigin([{ 출고장소코드: "2200" }]);
    expect(out.address).toBeNull();
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0].level).toBe("info");
  });

  it("등록된 주소가 둘 이상으로 갈리면 반영을 포기하고 경고한다", () => {
    // 지금 레지스트리는 1건뿐이라 충돌이 안 나므로, 2건짜리 가짜 레지스트리로 검증한다
    const fakeRegistry = {
      "2800": WAREHOUSE_ADDRESS_BY_SITE_CODE["2800"],
      "2200": { name: "일죽창고(수도권)", address: "경기도 안성시 일죽면 99" },
    };
    const out = deriveShipmentOrigin(
      [{ 출고장소코드: "2800" }, { 출고장소코드: "2200" }],
      fakeRegistry
    );
    expect(out.address).toBeNull();
    expect(out.issues.some((i) => i.level === "warning")).toBe(true);
  });
});
