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

import {
  assignDispatch,
  isHeavyOverweight,
  isLargeVehicle,
  isSameSite,
  isSouthOfMetro,
} from "@/lib/dispatch/assign";
import { METRO_SOUTH_LIMIT_LAT } from "@/lib/domain/constants";
import type { DeliveryPoint, GeoPoint, Vehicle } from "@/lib/domain/types";
import { cleanAddress, siteKey } from "@/lib/structure/delivery-name";

const CENTER: GeoPoint = { lat: 36.9924, lon: 127.1128 };

function point(
  company: string,
  boxes: number,
  address: string,
  geo: GeoPoint,
  region = "용인",
  pallets: number | null = null
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
      remarkRaw: null,
      fromRemark: [],
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
    items: [],
    pallets,
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
    palletLimit: null,
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

describe("R-07 1순위 — 권역 우선, 거리는 권역 주변 근사 (현업 확정 2026-09-23)", () => {
  const small = (over: Partial<Vehicle> = {}) =>
    vehicle({
      id: "V03",
      톤수라벨: "1톤",
      tonnage: 1,
      최소수량: 100,
      최대수량: 300,
      최소업체수: 1,
      최대업체수: 2,
      ...over,
    });

  it("더 가까워도 다른 권역보다 같은 권역 후보를 먼저 붙인다", () => {
    const seed = point("씨앗", 100, "경기도 용인시 처인구 중부대로 1199", 용인, "용인");
    // 씨앗과 같은 권역이지만 더 멀다 (약 16km)
    const sameRegionFar = point(
      "같은권역",
      80,
      "경기도 용인시 기흥구 포곡로 999",
      { lat: 37.35, lon: 127.3 },
      "용인"
    );
    // 씨앗과 권역은 다르지만 훨씬 가깝다 (약 0.6km)
    const otherRegionNear = point("다른권역", 80, "경기도 성남시 분당구 판교로 1", 용인2, "성남");

    const r = assignDispatch([seed, sameRegionFar, otherRegionNear], [small()], { centerGeo: CENTER });

    expect(r.trips).toHaveLength(1);
    expect(r.trips[0].points.map((p) => p.parsedName.company).sort()).toEqual(["같은권역", "씨앗"]);
    expect(r.unassigned.map((u) => u.company)).toEqual(["다른권역"]);
  });

  it("같은 권역 후보가 없으면 거리가 가까운 다른 권역을 2순위로 택한다", () => {
    const seed = point("씨앗", 100, "경기도 용인시 처인구 중부대로 1199", 용인, "용인");
    const otherRegionNear = point("다른권역", 80, "경기도 성남시 분당구 판교로 1", 용인2, "성남");

    const r = assignDispatch([seed, otherRegionNear], [small()], { centerGeo: CENTER });

    expect(r.trips).toHaveLength(1);
    expect(r.trips[0].points.map((p) => p.parsedName.company).sort()).toEqual(["다른권역", "씨앗"]);
  });
});

describe("R-19 — 차량 파렛트 상한 (요청 2026-09-23, OI-17 현업 확인 필요)", () => {
  it("차량 마스터에 파렛트상한이 없으면(palletLimit: null) 파렛트 수가 많아도 제약이 없다", () => {
    const p = point("씨앗", 100, "경기도 용인시 처인구 중부대로 1199", 용인, "용인", 999);
    const v = vehicle({
      최소수량: 50,
      최대수량: 1000,
      최소업체수: 1,
      최대업체수: 2,
      palletLimit: null,
    });

    const r = assignDispatch([p], [v], { centerGeo: CENTER });

    expect(r.trips).toHaveLength(1);
    expect(r.unassigned).toHaveLength(0);
  });

  it("palletLimit을 설정하면 합계가 넘는 조합을 배제한다", () => {
    const a = point("A", 100, "경기도 용인시 처인구 중부대로 1199", 용인, "용인", 5);
    const b = point("B", 100, "경기도 용인시 처인구 포곡로 234", 용인2, "용인", 5);
    const v = vehicle({
      최소수량: 50,
      최대수량: 1000,
      최소업체수: 1,
      최대업체수: 2,
      palletLimit: 5,
    });

    const r = assignDispatch([a, b], [v], { centerGeo: CENTER });

    expect(r.trips).toHaveLength(1);
    expect(r.trips[0].points).toHaveLength(1);
    expect(r.trips[0].points[0].pallets).toBe(5);
    expect(r.unassigned).toHaveLength(1);
  });

  it("배송지 파렛트수가 unresolved(null)면 그 배송지에는 제약을 걸지 않는다 — 모르면 막지 않는다", () => {
    const p = point("미상품목업체", 100, "경기도 용인시 처인구 중부대로 1199", 용인, "용인", null);
    const v = vehicle({
      최소수량: 50,
      최대수량: 1000,
      최소업체수: 1,
      최대업체수: 2,
      palletLimit: 1,
    });

    const r = assignDispatch([p], [v], { centerGeo: CENTER });

    expect(r.trips).toHaveLength(1);
    expect(r.unassigned).toHaveLength(0);
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

describe("R-06 — 다회전 분할은 같은 차량 안에서만 (분할잔여 방지)", () => {
  it("회전수 2 이상인 차량이 있으면 그 차량의 1·2회전에 나눠 싣는다", () => {
    const big = point("미담", 1373, "경기도 용인시 처인구 중부대로 1199", 용인);
    const twoTrip = vehicle({ 회전수: 2, 최소수량: 100, 최대수량: 1200 });

    const r = assignDispatch([big], [twoTrip], { centerGeo: CENTER });

    expect(r.unassigned).toHaveLength(0);
    expect(r.trips).toHaveLength(2);
    expect(r.trips.every((t) => t.vehicle.id === twoTrip.id)).toBe(true);
    expect(r.trips.map((t) => t.boxes).sort((a, b) => b - a)).toEqual([1200, 173]);
  });

  it("2회전 가능한 차량이 없으면 쪼개지 않고 통째로 기타에 남긴다", () => {
    const big = point("미담", 1373, "경기도 용인시 처인구 중부대로 1199", 용인);
    const oneTrip = vehicle({ 회전수: 1, 최대수량: 1200 });

    const r = assignDispatch([big], [oneTrip], { centerGeo: CENTER });

    expect(r.trips).toHaveLength(0);
    expect(r.unassigned).toHaveLength(1);
    expect(r.unassigned[0].boxes).toBe(1373);
    expect(r.unassigned[0].reason).toBe("적재상한");
  });

  it("분할 조각은 다른 차량으로 넘어가지 않는다", () => {
    const big = point("미담", 1373, "경기도 용인시 처인구 중부대로 1199", 용인);
    const oneTripBig = vehicle({ id: "V01", 회전수: 1, 최대수량: 1200 });
    const twoTripSmall = vehicle({
      id: "V02",
      회전수: 2,
      최소수량: 50,
      최대수량: 700,
      최소업체수: 1,
      최대업체수: 2,
    });

    const r = assignDispatch([big], [oneTripBig, twoTripSmall], { centerGeo: CENTER });

    expect(r.unassigned).toHaveLength(0);
    expect(r.trips.every((t) => t.vehicle.id === "V02")).toBe(true);
    expect(r.trips.map((t) => t.boxes).sort((a, b) => b - a)).toEqual([700, 673]);
  });
});

describe("R-20 — 같은 주소는 무조건 같은 회전 (요청 2026-09-23)", () => {
  const SAME_ADDR = "경기도 용인시 처인구 중부대로 1199";

  it("같은 주소 2개사가 항상 같은 회전에 담긴다", () => {
    const a = point("A업체", 100, SAME_ADDR, 용인);
    const b = point("B업체", 80, SAME_ADDR, 용인);
    const v = vehicle({ 최소수량: 50, 최대수량: 300, 최소업체수: 1, 최대업체수: 2 });

    const r = assignDispatch([a, b], [v], { centerGeo: CENTER });

    expect(r.trips).toHaveLength(1);
    expect(r.trips[0].points.map((p) => p.parsedName.company).sort()).toEqual(["A업체", "B업체"]);
    expect(r.unassigned).toHaveLength(0);
    expect(r.issues.some((i) => i.code === "R-20" && i.level === "info")).toBe(true);
  });

  it("그룹 전체를 실을 수 있는 차량이 없으면 쪼개지 않고 통째로 기타(주소동일잔여)로 남는다", () => {
    const a = point("A업체", 900, SAME_ADDR, 용인);
    const b = point("B업체", 900, SAME_ADDR, 용인);
    // 어느 차량도 합계 1,800박스를 못 싣는다(최대 1,200)
    const v = vehicle({ 최소수량: 50, 최대수량: 1200, 최소업체수: 1, 최대업체수: 2 });

    const r = assignDispatch([a, b], [v], { centerGeo: CENTER });

    expect(r.trips).toHaveLength(0);
    expect(r.unassigned).toHaveLength(2);
    expect(r.unassigned.every((u) => u.reason === "주소동일잔여")).toBe(true);
  });

  it("그룹 안에 조기납품 대상이 2곳이면 기사당 1곳(R-08)과 충돌해 배차되지 않는다", () => {
    const earlyTime = {
      windows: [{ start: 8 * 60, end: 10 * 60 }],
      columnRaw: "~10:00",
      fromColumn: [{ start: 8 * 60, end: 10 * 60 }],
      nameRaw: "",
      fromName: [],
      remarkRaw: null,
      fromRemark: [],
      conflict: false,
      mismatch: "none" as const,
      advisory: false,
      assumedOperating: false,
      hasExplicitStart: false,
      adopted: "column" as const,
      note: "",
    };
    const a = { ...point("A업체", 100, SAME_ADDR, 용인), time: earlyTime };
    const b = { ...point("B업체", 80, SAME_ADDR, 용인), time: earlyTime };
    const v = vehicle({ 최소수량: 50, 최대수량: 300, 최소업체수: 1, 최대업체수: 2 });

    const r = assignDispatch([a, b], [v], { centerGeo: CENTER });

    expect(r.trips).toHaveLength(0);
    expect(r.unassigned).toHaveLength(2);
    expect(r.unassigned.every((u) => u.reason === "주소동일잔여")).toBe(true);
  });

  it("R-06 분할 조각은 같은 주소라도 그룹화 대상이 아니다", () => {
    const big = point("미담", 1373, SAME_ADDR, 용인);
    // 분할 조각과 같은 주소를 쓰는 별개 소량 업체
    const small = point("소량업체", 50, SAME_ADDR, 용인);
    const twoTrip = vehicle({ id: "V01", 회전수: 2, 최소수량: 50, 최대수량: 1200 });

    const r = assignDispatch([big, small], [twoTrip], { centerGeo: CENTER });

    // 미담은 기존 R-06대로 1,200 + 173으로 분할되고, 소량업체는 별도로 처리된다
    // (분할 조각과 하드 묶이지 않으므로 크래시 없이 정상 처리되는지만 확인한다)
    const assignedBoxes = r.trips.flatMap((t) => t.points).reduce((s, p) => s + p.boxes, 0);
    const unassignedBoxes = r.unassigned.reduce((s, u) => s + u.boxes, 0);
    expect(assignedBoxes + unassignedBoxes).toBe(1373 + 50);
  });
});

describe("R-21 — 규격 중량 20kg 품목 50박스 이상은 미배차·일성 (요청 2026-09-23)", () => {
  it("20kg 품목 50박스 이상이면 지입 배차에서 제외되고 미배차·일성으로 분류된다 (동우참프레 회귀)", () => {
    const p = {
      ...point("동우참프레", 60, "인천광역시 서구 원창로89번길 4(원창동)", { lat: 37.51, lon: 126.68 }),
      items: [{ 품번: "P-정육편육", boxes: 60, spec: "20KG (10KG*2BAG)" }],
    };

    expect(isHeavyOverweight(p)).toBe(true);

    const r = assignDispatch([p], [vehicle()], { centerGeo: CENTER });

    expect(r.trips).toHaveLength(0);
    expect(r.unassigned).toHaveLength(1);
    expect(r.unassigned[0].reason).toBe("중량초과");
    expect(r.unassigned[0].siteGroup).toBe("일성");
    expect(r.issues.some((i) => i.code === "R-21" && i.level === "info")).toBe(true);
  });

  it("50박스 미만이면 정상 배차된다", () => {
    const p = {
      ...point("소량냉동육", 40, "경기도 용인시 처인구 중부대로 1199", 용인),
      items: [{ 품번: "P-소량", boxes: 40, spec: "20KG (10KG*2BAG)" }],
    };

    expect(isHeavyOverweight(p)).toBe(false);

    const r = assignDispatch([p], [vehicle({ 최소수량: 10, 최소업체수: 1 })], { centerGeo: CENTER });

    expect(r.trips).toHaveLength(1);
    expect(r.unassigned).toHaveLength(0);
  });

  it("20kg이 아닌 다른 중량 품목의 박스는 합산하지 않는다", () => {
    const p = {
      ...point("혼합품목업체", 70, "경기도 용인시 처인구 중부대로 1199", 용인),
      items: [
        { 품번: "P-20kg", boxes: 30, spec: "20KG (10KG*2BAG)" },
        { 품번: "P-10kg", boxes: 40, spec: "10KG(1KG*10BAGS)/BOX" },
      ],
    };

    // 20kg 품목만 보면 30박스로 기준(50) 미달 — 나머지 40박스는 10kg이라 합산하지 않는다
    expect(isHeavyOverweight(p)).toBe(false);
  });

  it("20kg 품목이 여러 줄로 나뉘어 있어도 합산해서 기준을 넘는지 본다", () => {
    const p = {
      ...point("분할입고업체", 55, "경기도 용인시 처인구 중부대로 1199", 용인),
      items: [
        { 품번: "P-20kg-a", boxes: 30, spec: "20KG (10KG*2BAG)" },
        { 품번: "P-20kg-b", boxes: 25, spec: "20KG(2BAG)" },
      ],
    };

    expect(isHeavyOverweight(p)).toBe(true);
  });
});
