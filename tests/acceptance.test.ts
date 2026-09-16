/**
 * PRD §12 수용 기준 — 2026-09-15 실데이터를 회귀 테스트 셋으로 고정한다.
 * docs/ 의 원본 엑셀을 그대로 읽으므로, 파일이 바뀌면 이 테스트가 먼저 깨진다.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

import { parseFleet } from "@/lib/parse/fleet";
import { parseShipment } from "@/lib/parse/shipment";
import { formatWindows } from "@/lib/structure/time-window";
import type { FleetParseResult, ShipmentParseResult } from "@/lib/domain/types";

const SHIPMENT_FILE = "docs/출고등록현황.xlsx";
const FLEET_FILE = "docs/차량 톤수.xlsx";

let ship: ShipmentParseResult;
let fleet: FleetParseResult;

beforeAll(async () => {
  ship = await parseShipment(readFileSync(SHIPMENT_FILE));
  fleet = await parseFleet(readFileSync(FLEET_FILE));
});

const find = (company: string) =>
  ship.points.find((p) => p.parsedName.company === company);

describe("AC-01 출고등록현황 집계", () => {
  it("총 304행 → 대상 287행 / 제외 17행", () => {
    expect(ship.totalRows).toBe(304);
    expect(ship.targetRows).toBe(287);
    expect(ship.excluded).toHaveLength(17);
  });

  it("제외 사유는 픽업 12 · 취소 4 · 이체 1", () => {
    const byReason = ship.excluded.reduce<Record<string, number>>((a, e) => {
      a[e.reason] = (a[e.reason] ?? 0) + 1;
      return a;
    }, {});
    expect(byReason).toEqual({ 픽업: 12, 취소: 4, 이체: 1 });
  });

  it("납품처 55곳 / 8,043박스", () => {
    expect(ship.points).toHaveLength(55);
    expect(ship.totalBoxes).toBe(8043);
  });

  it("출고일자는 20260915 단일", () => {
    expect(ship.date).toBe("20260915");
  });
});

describe("AC-02 차량 마스터 파생 지표", () => {
  it("기사 9명 · 총 12회전", () => {
    expect(fleet.vehicles).toHaveLength(9);
    expect(fleet.capacity.totalTrips).toBe(12);
  });

  it("적재 상한 8,225 / 하한 4,470", () => {
    expect(fleet.capacity.maxBoxes).toBe(8225);
    expect(fleet.capacity.minBoxes).toBe(4470);
  });

  it("업체 수 상한 42 / 하한 24", () => {
    expect(fleet.capacity.maxCompanies).toBe(42);
    expect(fleet.capacity.minCompanies).toBe(24);
  });
});

describe("AC-03 구조적 미배차 사전 경고", () => {
  it("납품처 55곳 > 업체 수 상한 42곳 → 최소 13곳 미배차", () => {
    const shortfall = ship.points.length - fleet.capacity.maxCompanies;
    expect(shortfall).toBe(13);
  });

  it("적재 상한은 총 물량보다 크지만 여유가 3% 미만", () => {
    expect(fleet.capacity.maxBoxes).toBeGreaterThan(ship.totalBoxes);
    const margin = (fleet.capacity.maxBoxes - ship.totalBoxes) / ship.totalBoxes;
    expect(margin).toBeLessThan(0.03);
  });
});

describe("AC-04 시간창 구조화", () => {
  it("납품시간 컬럼 보유 41곳", () => {
    const withColumn = ship.points.filter((p) => p.time.fromColumn.length > 0);
    expect(withColumn).toHaveLength(41);
  });

  it("AI/규칙 회수 후 최종 시간창 45곳", () => {
    const withWindow = ship.points.filter((p) => p.time.windows.length > 0);
    expect(withWindow).toHaveLength(45);
  });

  it("불일치 6건 — 경계 불일치 2 + 컬럼 결손 4", () => {
    const boundary = ship.points.filter((p) => p.time.mismatch === "boundary");
    const missing = ship.points.filter((p) => p.time.mismatch === "missing");
    expect(boundary).toHaveLength(2);
    expect(missing).toHaveLength(4);
    expect(boundary.length + missing.length).toBe(6);
  });

  it("컬럼 결손 4곳은 삼성웰스토리·신의유통·원앤원·지키미에프에스", () => {
    const names = ship.points
      .filter((p) => p.time.mismatch === "missing")
      .map((p) => p.parsedName.company)
      .sort();
    expect(names).toEqual(["삼성웰스토리", "신의유통", "원앤원", "지키미에프에스"]);
  });
});

describe("AC-05 지케이(광주새말길) 시간창", () => {
  it("컬럼 8:00~17:00이 아닌 원문 기준 08:00~12:30, 13:30~15:00을 채택", () => {
    const p = ship.points.find((x) => x.parsedName.region.startsWith("광주새말길"));
    expect(p).toBeDefined();
    expect(p!.time.columnRaw).toBe("8:00~17:00");
    expect(formatWindows(p!.time.windows)).toBe("08:00~12:30, 13:30~15:00");
    expect(p!.time.adopted).toBe("name");
  });
});

describe("AC-06 채움푸드 분리 시간창", () => {
  it("08:00~11:00 / 13:00~14:30 두 구간으로 분리", () => {
    const p = find("채움푸드");
    expect(p).toBeDefined();
    expect(p!.time.windows).toEqual([
      { start: 8 * 60, end: 11 * 60 },
      { start: 13 * 60, end: 14 * 60 + 30 },
    ]);
  });
});

describe("AC-07 박스 수 교차 검증", () => {
  it("비고 기재와 재고단위수량 합계 불일치 오탐 0건", () => {
    const mismatches = ship.issues.filter(
      (i) => i.code === "FR-07" && i.message.includes("박스 수")
    );
    expect(mismatches).toHaveLength(0);
  });

  it("SPC 양지1센터는 분할 기재를 합산해 245로 일치 판정", () => {
    const p = find("SPC[양지1센터]");
    expect(p).toBeDefined();
    expect(p!.boxes).toBe(245);
    expect(p!.memoBoxes).toBe(245);
  });

  it("하림충북은 총량 기재(1061) 옆의 부가 숫자에 속지 않는다", () => {
    const p = find("하림충북");
    expect(p).toBeDefined();
    expect(p!.boxes).toBe(1061);
    expect(p!.memoBoxes).toBe(1061);
  });
});

describe("AC-08 초과 물량 분할 대상", () => {
  it("미담/익산 1,373박스가 10톤 최대수량 1,200을 초과", () => {
    const p = find("미담");
    expect(p).toBeDefined();
    expect(p!.boxes).toBe(1373);
    const maxCap = Math.max(...fleet.vehicles.map((v) => v.최대수량));
    expect(maxCap).toBe(1200);
    expect(p!.boxes).toBeGreaterThan(maxCap);
  });

  it("1,200 초과 납품처는 미담 1곳뿐", () => {
    const over = ship.points.filter((p) => p.boxes > 1200);
    expect(over).toHaveLength(1);
  });
});

describe("AC-09 차량 톤수 제한 태그", () => {
  it("이슬푸드에서 3.5톤 이하 제약을 추출한다", () => {
    const p = find("이슬푸드");
    expect(p).toBeDefined();
    expect(p!.maxTonnage).toBe(3.5);
    expect(p!.tags).toContain("차량톤수제한");
  });

  it("톤수 제한이 걸린 납품처는 이슬푸드뿐", () => {
    const limited = ship.points.filter((p) => p.maxTonnage !== null);
    expect(limited.map((p) => p.parsedName.company)).toEqual(["이슬푸드"]);
  });
});

describe("AC-10 도착지 품질 이슈 검출 (§5.2.1)", () => {
  it("유종수·곽창훈 기사의 도착지 중복을 경고한다", () => {
    const dup = fleet.issues.find((i) => i.message.includes("도착지가 동일한 기사"));
    expect(dup).toBeDefined();
    expect(dup!.subject).toContain("유종수기사님");
    expect(dup!.subject).toContain("곽창훈기사님");
  });
});

describe("납품처 문자열 파싱 (FR-10 / §5.1.1)", () => {
  it("토큰 수 분포는 4토큰 49 · 5토큰 3 · 3토큰 3", () => {
    const dist = ship.points.reduce<Record<number, number>>((a, p) => {
      a[p.parsedName.tokenCount] = (a[p.parsedName.tokenCount] ?? 0) + 1;
      return a;
    }, {});
    expect(dist).toEqual({ 3: 3, 4: 49, 5: 3 });
  });

  it("코스코드 분포 3:12 · 4:12 · 5:29 · 10:1 · 20:1", () => {
    const dist = ship.points.reduce<Record<string, number>>((a, p) => {
      const k = String(p.parsedName.courseCode);
      a[k] = (a[k] ?? 0) + 1;
      return a;
    }, {});
    expect(dist).toEqual({ "3": 12, "4": 12, "5": 29, "10": 1, "20": 1 });
  });

  it("괄호·하이픈이 섞인 업체명·권역을 훼손하지 않는다", () => {
    expect(find("다봄푸드(오포저온물류센터)")).toBeDefined();
    expect(find("동원홈푸드(시화센터)")).toBeDefined();
    const bnj = find("비엔제이(신사옥)");
    expect(bnj?.parsedName.region).toBe("광주-문형산안길");
  });
});

describe("원거리 물량 (§5.3-(7))", () => {
  it("익산·청주 합계 2,434박스 = 전체의 30% 이상", () => {
    const far = ship.points.filter((p) =>
      ["익산", "청주"].includes(p.parsedName.region)
    );
    const boxes = far.reduce((s, p) => s + p.boxes, 0);
    expect(boxes).toBe(2434);
    expect(boxes / ship.totalBoxes).toBeGreaterThan(0.3);
  });
});
