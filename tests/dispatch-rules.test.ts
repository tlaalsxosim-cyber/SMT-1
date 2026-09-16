/**
 * R-17 대형차 1업체 원칙 · R-18 수도권 우선 — 규칙 단위 테스트
 *
 * 실데이터(pipeline.test.ts)는 "지금 이 데이터에서 규칙이 지켜졌다"만 보여 준다.
 * 여기서는 규칙 자체를 합성 데이터로 고정한다 — 데이터가 바뀌어도 규칙은 그대로여야 한다.
 *
 * 현업 지적(2026-09-16): 10톤 차(최소 500박스)에 30박스짜리가 얹혀 실려 나갔다.
 * 대형차는 회전당 1업체가 원칙이고, 2번째 업체는 주소가 거의 동일할 때만 붙인다.
 */
import { describe, expect, it } from "vitest";

import { assignDispatch, isLargeVehicle, isSameSite, isSouthOfMetro } from "@/lib/dispatch/assign";
import { METRO_SOUTH_LIMIT_LAT } from "@/lib/domain/constants";
import type { DeliveryPoint, GeoPoint, Vehicle } from "@/lib/domain/types";
import { cleanAddress, siteKey } from "@/lib/structure/delivery-name";

const CENTER: GeoPoint = { lat: 36.9924, lon: 127.1128 };

function point(
  company: string,
  boxes: number,
  address: string,
  geo: GeoPoint,
  region = "용인"
): DeliveryPoint {
  return {
    id: `${company}|${address}`,
    raw납품처: `5/${company}/${region}/`,
    address,
    cleanAddress: cleanAddress(address),
    parsedName: {
      courseCode: 5,
      company,
      region,
      conditionText: "",
      tokenCount: 4,
      raw: `5/${company}/${region}/`,
    },
    boxes,
    rowNos: [2],
    contact: null,
    memos: [],
    memoBoxes: null,
    time: {
      windows: [],
      columnRaw: null,
      fromColumn: [],
      nameRaw: "",
      fromName: [],
      conflict: false,
      mismatch: "none",
      advisory: false,
      assumedOperating: false,
      hasExplicitStart: false,
      adopted: "none",
      note: "시간 제약 없음",
    },
    tags: [],
    maxTonnage: null,
    geo: { ...geo, source: "demo", queriedAddress: address },
  };
}

function vehicle(over: Partial<Vehicle> = {}): Vehicle {
  return {
    id: "V01",
    기사명: "테스트기사님",
    톤수라벨: "10톤",
    tonnage: 10,
    최소수량: 500,
    최대수량: 1200,
    회전수: 1,
    최소업체수: 1,
    최대업체수: 2,
    도착지: "경기도 용인시 처인구 중부대로 1199",
    cleanArrival: "경기도 용인시 처인구 중부대로 1199",
    arrivalGeo: { lat: 37.2, lon: 127.2, source: "demo", queriedAddress: "용인" },
    ...over,
  };
}

// 평택센터 북쪽 — 수도권
const 용인: GeoPoint = { lat: 37.24, lon: 127.18 };
const 용인2: GeoPoint = { lat: 37.245, lon: 127.185 };
// 천안 이남
const 천안: GeoPoint = { lat: 36.81, lon: 127.15 };
const 청주: GeoPoint = { lat: 36.64, lon: 127.49 };

describe("siteKey — 같은 장소 판정 (R-17)", () => {
  it("시·도 표기가 달라도 같은 장소로 본다", () => {
    expect(siteKey("경기도 광주시 새말길 126")).toBe(siteKey("경기 광주시 새말길 126"));
  });

  it("층·도크·건물명이 붙어도 같은 장소로 본다", () => {
    expect(siteKey("경기 광주시 새말길 126 3층 7번도크")).toBe(siteKey("경기도 광주시 새말길 126"));
  });

  it("같은 시·군의 다른 도로는 다른 장소다", () => {
    expect(siteKey("경기도 광주시 새말길 126")).not.toBe(siteKey("경기도 광주시 세피내길 25"));
  });

  it("번길 번호가 다르면 다른 장소다", () => {
    expect(siteKey("용인시 처인구 죽양대로 2071번길 10-8")).not.toBe(
      siteKey("용인시 처인구 죽양대로 2071번길 22")
    );
  });

  it("지번 주소도 번지까지 읽는다", () => {
    expect(siteKey("인천 서구 가좌동 173-226")).toBe("인천서구가좌동173-226");
    expect(siteKey("인천광역시 서구 가좌동 173-226")).toBe("인천서구가좌동173-226");
  });

  it("빈 주소는 빈 키 — 같은 장소로 오인하지 않는다", () => {
    expect(siteKey("")).toBe("");
    const a = point("A", 10, "", 용인);
    const b = point("B", 10, "", 용인);
    expect(isSameSite(a, b)).toBe(false);
  });
});

describe("isLargeVehicle / isSouthOfMetro", () => {
  it("5톤 이상이 대형차다", () => {
    expect(isLargeVehicle({ tonnage: 10 })).toBe(true);
    expect(isLargeVehicle({ tonnage: 5 })).toBe(true);
    expect(isLargeVehicle({ tonnage: 4 })).toBe(false);
    expect(isLargeVehicle({ tonnage: 3.5 })).toBe(false);
  });

  it("천안·청주는 남쪽, 용인·평택은 북쪽", () => {
    expect(isSouthOfMetro(point("천안업체", 10, "충남 천안시 번영로 725", 천안))).toBe(true);
    expect(isSouthOfMetro(point("청주업체", 10, "충북 청주시 청남로 1388-44", 청주))).toBe(true);
    expect(isSouthOfMetro(point("용인업체", 10, "경기 용인시 중부대로 1199", 용인))).toBe(false);
    expect(METRO_SOUTH_LIMIT_LAT).toBe(36.9);
  });

  it("좌표가 없으면 남쪽으로 몰지 않는다", () => {
    const p = point("좌표없음", 10, "경기 용인시 중부대로 1199", 용인);
    delete p.geo;
    expect(isSouthOfMetro(p)).toBe(false);
  });
});

describe("R-17 — 대형차는 회전당 1업체", () => {
  it("주소가 다른 소량 업체를 대형 물량에 얹지 않는다 (원앤원 30박스 회귀)", () => {
    // 실데이터의 `원앤원 30 + 하림충북 1,061`은 둘 다 천안 이남이라 R-18이 먼저 걷어 낸다.
    // 규칙 자체를 보기 위해 같은 상황을 수도권 좌표로 재현한다.
    const big = point("대형물류", 1000, "경기도 용인시 처인구 중부대로 1199", 용인);
    const small = point("소량업체", 30, "경기도 용인시 기흥구 청마로 29-4", { lat: 37.26, lon: 127.15 });

    const r = assignDispatch([big, small], [vehicle()], { centerGeo: CENTER });

    expect(r.trips).toHaveLength(1);
    expect(r.trips[0].points.map((p) => p.parsedName.company)).toEqual(["대형물류"]);
    expect(r.unassigned.map((u) => u.company)).toEqual(["소량업체"]);
  });

  it("주소가 거의 같으면 2업체까지 붙인다", () => {
    const a = point("A물류", 600, "경기도 용인시 처인구 중부대로 1199 1층", 용인);
    const b = point("B식품", 300, "경기 용인시 처인구 중부대로 1199 지하2층 5번도크", 용인2);

    const r = assignDispatch([a, b], [vehicle()], { centerGeo: CENTER });

    expect(r.trips).toHaveLength(1);
    expect(r.trips[0].points.map((p) => p.parsedName.company).sort()).toEqual(["A물류", "B식품"]);
    expect(r.unassigned).toHaveLength(0);
  });

  it("단독으로 적재 하한을 못 채우는 소량은 대형차에 배차하지 않는다", () => {
    const small = point("소량업체", 300, "경기도 용인시 처인구 중부대로 1199", 용인);

    const r = assignDispatch([small], [vehicle()], { centerGeo: CENTER });

    expect(r.trips).toHaveLength(0);
    expect(r.unassigned[0].reason).toBe("대형차단독");
    expect(r.unassigned[0].note).toContain("500");
  });

  it("소형차(4톤 이하)는 주소가 달라도 여러 업체를 묶는다", () => {
    const small4 = vehicle({
      id: "V02",
      톤수라벨: "4톤",
      tonnage: 4,
      최소수량: 370,
      최대수량: 400,
      최소업체수: 3,
      최대업체수: 5,
    });
    const pts = [
      point("가", 150, "경기도 용인시 처인구 중부대로 1199", 용인),
      point("나", 130, "경기도 용인시 처인구 포곡로 234", { lat: 37.25, lon: 127.22 }),
      point("다", 110, "경기도 용인시 기흥구 청마로 29-4", { lat: 37.26, lon: 127.15 }),
    ];

    const r = assignDispatch(pts, [small4], { centerGeo: CENTER });

    expect(r.trips).toHaveLength(1);
    expect(r.trips[0].points).toHaveLength(3);
  });
});

describe("R-18 — 천안 이남은 지입 배차에서 제외", () => {
  it("북쪽 대안이 있으면 북쪽을 태운다", () => {
    const north = point("용인업체", 700, "경기도 용인시 처인구 중부대로 1199", 용인);
    const south = point("청주업체", 700, "충북 청주시 청남로 1388-44", 청주, "청주");

    const r = assignDispatch([north, south], [vehicle()], { centerGeo: CENTER });

    expect(r.trips).toHaveLength(1);
    expect(r.trips[0].points[0].parsedName.company).toBe("용인업체");
    expect(r.unassigned.map((u) => u.company)).toEqual(["청주업체"]);
  });

  it("북쪽 대안이 없어도 남쪽은 태우지 않는다 — 후순위가 아니라 제외다", () => {
    const south = point("청주업체", 700, "충북 청주시 청남로 1388-44", 청주, "청주");

    const r = assignDispatch([south], [vehicle()], { centerGeo: CENTER });

    expect(r.trips).toHaveLength(0);
    expect(r.unassigned).toHaveLength(1);
    expect(r.unassigned[0].reason).toBe("수도권외");
    expect(r.unassigned[0].note).toContain("용차");
  });

  it("제외한 물량은 버리지 않고 사유와 함께 기타로 넘긴다 (R-12)", () => {
    const north = point("용인업체", 700, "경기도 용인시 처인구 중부대로 1199", 용인);
    const south = point("익산업체", 900, "전라북도 익산시 왕궁면 왕궁농공단지길 81", { lat: 35.95, lon: 127.03 }, "익산");

    const r = assignDispatch([north, south], [vehicle()], { centerGeo: CENTER });

    const assigned = r.trips.flatMap((t) => t.points).reduce((s, p) => s + p.boxes, 0);
    const left = r.unassigned.reduce((s, u) => s + u.boxes, 0);
    expect(assigned + left).toBe(1600);
    expect(r.issues.some((i) => i.code === "R-18" && i.level === "info")).toBe(true);
  });

  it("남쪽 대형 물량은 분할하지 않고 통째로 제외한다", () => {
    // 미담 1,373박스 — 10톤 최대 1,200을 넘지만 R-18로 먼저 빠지므로 쪼개지 않는다
    const south = point("미담", 1373, "전라북도 익산시 왕궁면 왕궁농공단지길 81", { lat: 35.95, lon: 127.03 }, "익산");

    const r = assignDispatch([south], [vehicle()], { centerGeo: CENTER });

    expect(r.unassigned).toHaveLength(1);
    expect(r.unassigned[0].boxes).toBe(1373);
    expect(r.unassigned[0].reason).toBe("수도권외");
  });

  it("소형차 묶음에서도 남쪽은 빠진다", () => {
    const small4 = vehicle({
      id: "V02",
      톤수라벨: "4톤",
      tonnage: 4,
      최소수량: 370,
      최대수량: 400,
      최소업체수: 3,
      최대업체수: 4,
    });
    const pts = [
      point("북1", 150, "경기도 용인시 처인구 중부대로 1199", 용인),
      point("북2", 130, "경기도 용인시 처인구 포곡로 234", { lat: 37.25, lon: 127.22 }),
      point("북3", 110, "경기도 용인시 기흥구 청마로 29-4", { lat: 37.26, lon: 127.15 }),
      point("남1", 10, "충남 천안시 번영로 725", 천안, "천안"),
    ];

    const r = assignDispatch(pts, [small4], { centerGeo: CENTER });

    expect(r.trips).toHaveLength(1);
    expect(r.trips[0].points.map((p) => p.parsedName.company).sort()).toEqual(["북1", "북2", "북3"]);
    expect(r.unassigned.map((u) => u.reason)).toEqual(["수도권외"]);
  });

  it("대형차가 통째로 놀면 경고로 알린다", () => {
    // 수도권에 500박스를 단독으로 채우는 업체가 없는 상황
    const pts = [point("소량업체", 300, "경기도 용인시 처인구 중부대로 1199", 용인)];

    const r = assignDispatch(pts, [vehicle()], { centerGeo: CENTER });

    expect(r.trips).toHaveLength(0);
    const warn = r.issues.find((i) => i.level === "warning" && i.code === "R-17");
    expect(warn).toBeDefined();
    expect(warn!.message).toContain("공차");
  });
});
