/**
 * E2E 파이프라인 회귀 테스트 — Demo Mode로 API 호출 없이 전 과정을 돌린다 (AC-11 ~ AC-15).
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

import { splitOversized } from "@/lib/dispatch/assign";
import { parseFleet } from "@/lib/parse/fleet";
import { parseShipment } from "@/lib/parse/shipment";
import { runPipeline, type RunOutput } from "@/lib/pipeline/run";
import {
  LARGE_VEHICLE_TONNAGE,
  METRO_SOUTH_LIMIT_LAT,
  SECOND_TRIP_MIN_DEADLINE,
} from "@/lib/domain/constants";
import { siteKey } from "@/lib/structure/delivery-name";

let out: RunOutput;
let totalBoxes: number;
let maxCompanies: number;
let points: Awaited<ReturnType<typeof parseShipment>>["points"];

beforeAll(async () => {
  const ship = await parseShipment(readFileSync("docs/출고등록현황.xlsx"));
  const fleet = await parseFleet(readFileSync("docs/차량 톤수.xlsx"));
  totalBoxes = ship.totalBoxes;
  maxCompanies = fleet.capacity.maxCompanies;
  points = ship.points;

  out = await runPipeline(ship, fleet, {
    demo: true,
    useAi: false,
    drawRoutes: true,
  });
}, 120_000);

describe("AC-11 제약 위반 0건", () => {
  it("적재·업체수·시간창·톤수 제약 위반이 없다", () => {
    if (out.violations.length) {
      console.error(out.violations.map((v) => `[${v.code}] ${v.subject} — ${v.message}`));
    }
    expect(out.violations).toHaveLength(0);
  });

  it("모든 회전이 적재 범위 안에 있다", () => {
    for (const t of out.trips) {
      const v = out.vehicles.find((x) => x.id === t.vehicleId)!;
      expect(t.boxes).toBeGreaterThanOrEqual(v.최소수량);
      expect(t.boxes).toBeLessThanOrEqual(v.최대수량);
    }
  });

  it("모든 회전이 업체 수 범위 안에 있다", () => {
    for (const t of out.trips) {
      const v = out.vehicles.find((x) => x.id === t.vehicleId)!;
      expect(t.stops.length).toBeGreaterThanOrEqual(v.최소업체수);
      expect(t.stops.length).toBeLessThanOrEqual(v.최대업체수);
    }
  });

  it("차량 톤수 제약을 지킨다 (AC-09 이슬푸드)", () => {
    for (const t of out.trips) {
      const v = out.vehicles.find((x) => x.id === t.vehicleId)!;
      for (const s of t.stops) {
        if (s.maxTonnage !== null) expect(v.tonnage).toBeLessThanOrEqual(s.maxTonnage);
      }
    }
  });

  it("시간창 경고가 없다", () => {
    const warnings = out.trips.flatMap((t) => t.stops).filter((s) => s.timeOk === false);
    expect(warnings).toHaveLength(0);
  });
});

describe("AC-12 API 호출 예산", () => {
  it("Demo Mode는 TMAP을 한 번도 부르지 않는다 (AC-14)", () => {
    expect(out.demoMode).toBe(true);
    expect(out.apiUsage).toEqual({ geocode: 0, routes: 0, sequential: 0, optimize: 0, map: 0 });
  });

  it("회전 수가 12를 넘지 않는다 — 최적화 호출 상한의 근거", () => {
    expect(out.trips.length).toBeLessThanOrEqual(12);
  });
});

describe("AC-15 결과 정합성", () => {
  it("배차 + 기타 박스 = 총 물량 8,043", () => {
    expect(out.totalBoxes).toBe(totalBoxes);
    expect(out.assignedBoxes + out.unassignedBoxes).toBe(totalBoxes);
  });

  it("미배차 전 건에 사유 코드가 붙어 있다 (FR-43)", () => {
    expect(out.unassigned.length).toBeGreaterThan(0);
    for (const u of out.unassigned) {
      expect(u.reason).toBeTruthy();
      expect(u.note).toBeTruthy();
    }
  });

  it("같은 배송지가 두 번 배차되지 않는다", () => {
    const ids = out.trips.flatMap((t) => t.stops.map((s) => s.pointId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("배차된 업체 수가 업체 수 상한(42)을 넘지 않는다 (AC-03)", () => {
    const count = out.trips.reduce((s, t) => s + t.stops.length, 0);
    expect(count).toBeLessThanOrEqual(maxCompanies);
  });
});

describe("R-06 초과 물량 분할 (AC-08)", () => {
  /**
   * 미담 1,373박스는 10톤 최대수량 1,200을 넘지만, **R-18이 먼저 걷어 낸다**(익산).
   * 실을 생각이 없는 물량을 쪼개 봐야 기타 시트만 두 줄로 늘어난다 —
   * 통째로 한 줄에 남겨야 용차 판단이 쉽다.
   */
  it("수도권 외 초과 물량은 쪼개지 않고 통째로 기타에 남는다", () => {
    const all = [
      ...out.trips.flatMap((t) => t.stops.map((s) => ({ company: s.company, boxes: s.boxes }))),
      ...out.unassigned.map((u) => ({ company: u.company, boxes: u.boxes })),
    ];
    const mid = all.filter((x) => x.company.startsWith("미담"));
    expect(mid.map((x) => x.boxes)).toEqual([1373]);
  });

  it("분할 규칙 자체는 그대로다 — 1,373 → 1,200 + 173", () => {
    const p = points.find((x) => x.parsedName.company === "미담")!;
    const { points: split } = splitOversized([p], 1200);
    expect(split.map((x) => x.boxes)).toEqual([1200, 173]);
    expect(split.every((x) => x.splitFrom === p.id)).toBe(true);
  });
});

describe("R-08 조기납품 — 한 기사당 1곳 제한", () => {
  const isEarly = (windows: { start: number; end: number }[]) =>
    windows.some((w) => w.end <= 10 * 60);

  it("한 기사에게 조기납품 업체가 2곳 이상 배정되지 않는다", () => {
    const byDriver = new Map<string, string[]>();
    for (const t of out.trips) {
      for (const s of t.stops) {
        if (!isEarly(s.windows)) continue;
        byDriver.set(t.기사명, [...(byDriver.get(t.기사명) ?? []), `${s.company}(${t.tripNo}회전)`]);
      }
    }
    for (const [기사명, list] of byDriver) {
      expect(list, `${기사명}: ${list.join(", ")}`).toHaveLength(1);
    }
  });

  it("회전 번호는 제약이 아니다 — 2회전 배정을 규칙으로 금지하지 않는다", () => {
    // 규칙이 아니라 시간 실현성이 판단하므로, 2회전에 조기납품이 오더라도 위반이 아니다.
    const earlyOnSecondTrip = out.trips
      .filter((t) => t.tripNo > 1)
      .flatMap((t) => t.stops.filter((s) => isEarly(s.windows)));

    for (const s of earlyOnSecondTrip) {
      expect(s.timeOk, `${s.company} 도착 ${s.arriveAt}`).not.toBe(false);
    }
    expect(out.violations.filter((v) => v.code === "R-08")).toHaveLength(0);
  });
});

describe("R-15 2회전 납품 마감 하한 — 센터 복귀 후 재출발", () => {
  /** 현업 확정값 15:00 */
  const FLOOR = 15 * 60;

  it("확정 기준값이 15:00이다", () => {
    expect(SECOND_TRIP_MIN_DEADLINE).toBe(FLOOR);
  });

  it("2회전 이상 회전에는 마감이 15:00보다 이른 배송지가 없다", () => {
    const secondTripStops = out.trips.filter((t) => t.tripNo > 1).flatMap((t) => t.stops);
    for (const s of secondTripStops) {
      if (s.windows.length === 0) continue; // 시간 제약 없는 배송지는 허용
      const deadline = Math.max(...s.windows.map((w) => w.end));
      expect(deadline, `${s.company} 마감`).toBeGreaterThanOrEqual(FLOOR);
    }
  });

  it("1회전에는 하한을 적용하지 않는다 — 마감이 15:00보다 이른 배송지가 존재한다", () => {
    const firstTripEarly = out.trips
      .filter((t) => t.tripNo === 1)
      .flatMap((t) => t.stops)
      .filter((s) => s.windows.length > 0 && Math.max(...s.windows.map((w) => w.end)) < FLOOR);
    expect(firstTripEarly.length).toBeGreaterThan(0);
  });

  it("R-15 위반이 검증에서 잡히지 않는다", () => {
    expect(out.violations.filter((v) => v.code === "R-15")).toHaveLength(0);
  });
});

describe("납품 시작 시각 08:00 고정", () => {
  it("마감만 주어진 시간창의 시작이 08:00이다", () => {
    const deadlineOnly = out.trips
      .flatMap((t) => t.stops)
      .filter((s) => s.windows.length === 1 && !s.hasExplicitStart);
    expect(deadlineOnly.length).toBeGreaterThan(0);
    for (const s of deadlineOnly) {
      expect(s.windows[0].start, `${s.company}`).toBe(8 * 60);
    }
  });

  it("어떤 하차도 08:00 이전에 일어나지 않는다 (시간 제약이 있는 배송지)", () => {
    for (const t of out.trips) {
      for (const s of t.stops) {
        if (s.windows.length === 0 || s.arriveAt === null) continue;
        expect(s.arriveAt, `${s.company} 도착`).toBeGreaterThanOrEqual(8 * 60);
      }
    }
  });
});

describe("R-09 회전 간 동선 — 센터 복귀 후 재상차", () => {
  it("2회전 차량의 2회전은 1회전보다 늦게 출발한다", () => {
    const multiTrip = out.vehicles.filter((v) => v.회전수 > 1);
    for (const v of multiTrip) {
      const trips = out.trips
        .filter((t) => t.vehicleId === v.id)
        .sort((a, b) => a.tripNo - b.tripNo);
      for (let i = 1; i < trips.length; i++) {
        expect(
          trips[i].departAt,
          `${v.기사명} ${trips[i].tripNo}회전 출발`
        ).toBeGreaterThan(trips[i - 1].departAt);
      }
    }
  });

  it("마지막 회전만 기사 도착지로 귀가하고, 앞 회전은 센터로 복귀한다", () => {
    for (const v of out.vehicles) {
      const trips = out.trips.filter((t) => t.vehicleId === v.id);
      for (const t of trips) {
        const lastStop = t.stops[t.stops.length - 1];
        if (!lastStop?.geo) continue;

        const target =
          t.tripNo === v.회전수 && v.arrivalGeo ? v.arrivalGeo : out.centerGeo;
        // homeKm은 마지막 하차지 → 해당 회전의 도착지 거리여야 한다
        const expected = haversine(lastStop.geo, target) * 1.35;
        expect(t.homeKm, `${v.기사명} ${t.tripNo}회전`).toBeCloseTo(expected, 1);
      }
    }
  });
});

function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

describe("R-07 귀가 동선", () => {
  it("마지막 회전은 기사 도착지로 귀가한다", () => {
    const finals = out.trips.filter((t) => {
      const v = out.vehicles.find((x) => x.id === t.vehicleId)!;
      return t.tripNo === v.회전수;
    });
    expect(finals.length).toBeGreaterThan(0);
    for (const t of finals) expect(t.homeKm).toBeGreaterThanOrEqual(0);
  });

  it("모든 회전에 주행거리와 귀가거리가 계산되어 있다", () => {
    for (const t of out.trips) {
      expect(Number.isFinite(t.driveKm)).toBe(true);
      expect(Number.isFinite(t.homeKm)).toBe(true);
    }
  });
});

describe("지도 경로선 (FR-28)", () => {
  it("회전마다 [위도, 경도] 순의 경로선이 있다", () => {
    for (const t of out.trips) {
      const path = out.routePaths[t.id];
      expect(path).toBeDefined();
      expect(path.length).toBeGreaterThanOrEqual(2);
      for (const [lat, lon] of path) {
        // 대한민국 범위 — 위경도가 뒤집히면 여기서 걸린다
        expect(lat).toBeGreaterThan(33);
        expect(lat).toBeLessThan(39);
        expect(lon).toBeGreaterThan(124);
        expect(lon).toBeLessThan(132);
      }
    }
  });
});

describe("R-17 대형차 1업체 원칙 — 5톤 이상", () => {
  const largeTrips = () =>
    out.trips.filter((t) => {
      const v = out.vehicles.find((x) => x.id === t.vehicleId);
      return v ? v.tonnage >= LARGE_VEHICLE_TONNAGE : false;
    });

  it("대형차 회전에는 업체가 1곳뿐이거나, 2곳이면 주소가 거의 동일하다", () => {
    for (const t of largeTrips()) {
      if (t.stops.length <= 1) continue;
      const sites = new Set(t.stops.map((s) => siteKey(s.address)));
      expect(sites.size, `${t.기사명} ${t.tripNo}회전: ${t.stops.map((s) => s.company).join(", ")}`).toBe(1);
    }
  });

  it("대형차에 적재 하한 미만의 소량 업체가 얹혀 실리지 않는다 — 원앤원 30박스 회귀", () => {
    for (const t of largeTrips()) {
      const v = out.vehicles.find((x) => x.id === t.vehicleId)!;
      // 1업체 원칙이므로 회전 물량 = 그 업체 물량이고, 하한을 넘어야 한다
      expect(t.boxes).toBeGreaterThanOrEqual(v.최소수량);
    }
    const 원앤원 = out.trips
      .flatMap((t) => t.stops)
      .find((s) => s.company === "원앤원");
    expect(원앤원).toBeUndefined();
  });

  it("소형차(4톤 이하)에는 이 제약이 걸리지 않는다 — 3~5개사 묶음이 그대로 나온다", () => {
    const small = out.trips.filter((t) => {
      const v = out.vehicles.find((x) => x.id === t.vehicleId);
      return v ? v.tonnage < LARGE_VEHICLE_TONNAGE : false;
    });
    expect(small.length).toBeGreaterThan(0);
    expect(small.some((t) => t.stops.length >= 3)).toBe(true);
  });

  it("R-17 위반이 검증에서 잡히지 않는다", () => {
    expect(out.violations.filter((v) => v.code === "R-17")).toHaveLength(0);
  });
});

describe("R-18 천안 이남은 지입 배차에서 제외", () => {
  it("배차표에 천안 이남 배송지가 하나도 없다", () => {
    const south = out.trips
      .flatMap((t) => t.stops)
      .filter((s) => s.geo && s.geo.lat < METRO_SOUTH_LIMIT_LAT);
    expect(south.map((s) => s.company)).toEqual([]);
  });

  it("익산 미담·청주 하림충북은 사유 「수도권외」로 기타에 남는다", () => {
    const byCompany = new Map(out.unassigned.map((u) => [u.company, u]));
    for (const name of ["미담", "하림충북"]) {
      expect(byCompany.get(name), name).toBeDefined();
      expect(byCompany.get(name)!.reason, name).toBe("수도권외");
    }
  });

  it("제외한 물량도 총량에 그대로 남는다 (R-12)", () => {
    expect(out.assignedBoxes + out.unassignedBoxes).toBe(totalBoxes);
  });

  it("제외 사실을 정보 이슈로 남긴다", () => {
    const issue = out.issues.find((i) => i.code === "R-18");
    expect(issue).toBeDefined();
    expect(issue!.level).toBe("info");
    expect(issue!.message).toContain("제외");
  });

  it("R-18 위반이 검증에서 잡히지 않는다", () => {
    expect(out.violations.filter((v) => v.code === "R-18")).toHaveLength(0);
  });

  it("수도권에 적재 하한을 채울 업체가 없어 대형차가 공차라는 사실을 경고한다", () => {
    const warn = out.issues.find((i) => i.code === "R-17" && i.level === "warning");
    expect(warn).toBeDefined();
    expect(warn!.message).toContain("공차");
  });
});
