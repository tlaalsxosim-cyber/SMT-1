/**
 * 회전 단위 시간 실현성 시뮬레이터 (R-09, R-14 / FR-40)
 *
 * TMAP 최적화를 부르기 **전에** 직선거리 근사로 조합의 실현 가능성을 판단한다.
 * 조합 탐색은 수천 번 돌기 때문에 여기서 API를 부르면 무료 한도가 즉시 소진된다 (FR-30).
 * 최종 검증은 TMAP arriveTime으로 다시 수행한다 (FR-25, FR-26).
 */

import { UNLOAD_MINUTES } from "@/lib/domain/constants";
import type { GeoPoint, Minutes, TimeWindow } from "@/lib/domain/types";
import { distKm, travelMinutes } from "./distance";

export interface SimStop {
  id: string;
  geo: GeoPoint;
  windows: TimeWindow[];
  /** 권장 표현이면 위반해도 경고로만 처리한다 */
  advisory: boolean;
}

export interface SimResult {
  /** 방문 순서대로 정렬된 id */
  order: string[];
  arriveAt: Record<string, Minutes>;
  /** 시간창을 지키지 못한 id */
  violations: string[];
  /** 권장 시간을 넘긴 id (배차는 허용) */
  softViolations: string[];
  /** 센터 → 마지막 하차지 주행거리 */
  driveKm: number;
  /** 마지막 하차지 → 도착지 공차 거리 */
  homeKm: number;
  /** 도착지 도착 시각 */
  endAt: Minutes;
  feasible: boolean;
}

/**
 * 시간창 배열에서 `clock` 시점에 하차 가능한 시각을 찾는다.
 * 너무 일찍 도착했으면 창이 열릴 때까지 기다린다.
 * @returns 실제 하차 시각. 모든 창을 넘겼으면 null.
 */
export function fitIntoWindows(windows: TimeWindow[], clock: Minutes): Minutes | null {
  if (windows.length === 0) return clock;
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  for (const w of sorted) {
    if (clock > w.end) continue;
    return clock < w.start ? w.start : clock;
  }
  return null;
}

/** 최근접 이웃으로 초기 순서를 만들고 2-opt로 다듬는다 */
export function orderStops(start: GeoPoint, stops: SimStop[], end: GeoPoint): SimStop[] {
  if (stops.length <= 1) return [...stops];

  const remaining = [...stops];
  const ordered: SimStop[] = [];
  let cursor = start;

  while (remaining.length) {
    let bestIdx = 0;
    let bestKm = Infinity;
    remaining.forEach((s, i) => {
      const km = distKm(cursor, s.geo);
      if (km < bestKm) {
        bestKm = km;
        bestIdx = i;
      }
    });
    const [picked] = remaining.splice(bestIdx, 1);
    ordered.push(picked);
    cursor = picked.geo;
  }

  const totalOf = (seq: SimStop[]): number => {
    let km = 0;
    let prev = start;
    for (const s of seq) {
      km += distKm(prev, s.geo);
      prev = s.geo;
    }
    return km + distKm(prev, end);
  };

  let best = ordered;
  let bestTotal = totalOf(best);
  let improved = true;

  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = [...best];
        const slice = candidate.slice(i, j + 1).reverse();
        candidate.splice(i, j - i + 1, ...slice);
        const total = totalOf(candidate);
        if (total < bestTotal - 1e-9) {
          best = candidate;
          bestTotal = total;
          improved = true;
        }
      }
    }
  }

  return best;
}

/**
 * 시간창을 고려해 순서를 다듬는다.
 * 거리 최적 순서가 마감이 이른 배송지를 뒤로 미루면 위반이 나므로,
 * 마감이 이른 순서를 우선하는 후보와 비교해 위반이 적은 쪽을 택한다.
 */
function deadlineFirst(stops: SimStop[]): SimStop[] {
  return [...stops].sort((a, b) => {
    const da = a.windows.length ? Math.min(...a.windows.map((w) => w.end)) : Infinity;
    const db = b.windows.length ? Math.min(...b.windows.map((w) => w.end)) : Infinity;
    return da - db;
  });
}

function run(
  start: GeoPoint,
  sequence: SimStop[],
  end: GeoPoint,
  departAt: Minutes
): SimResult {
  const arriveAt: Record<string, Minutes> = {};
  const violations: string[] = [];
  const softViolations: string[] = [];

  let clock = departAt;
  let prev = start;
  let driveKm = 0;

  for (const s of sequence) {
    const km = distKm(prev, s.geo);
    driveKm += km;
    clock += travelMinutes(km);

    const fitted = fitIntoWindows(s.windows, clock);
    if (fitted === null) {
      if (s.advisory) softViolations.push(s.id);
      else violations.push(s.id);
      arriveAt[s.id] = clock;
    } else {
      clock = fitted;
      arriveAt[s.id] = clock;
    }

    clock += UNLOAD_MINUTES;
    prev = s.geo;
  }

  const homeKm = distKm(prev, end);
  const endAt = clock + travelMinutes(homeKm);

  return {
    order: sequence.map((s) => s.id),
    arriveAt,
    violations,
    softViolations,
    driveKm: Number(driveKm.toFixed(2)),
    homeKm: Number(homeKm.toFixed(2)),
    endAt,
    feasible: violations.length === 0,
  };
}

/**
 * 회전 하나를 시뮬레이션한다.
 * 거리 최적 순서와 마감 우선 순서를 모두 돌려 위반이 적은 쪽(동률이면 짧은 쪽)을 택한다.
 */
export function simulateTrip(
  start: GeoPoint,
  stops: SimStop[],
  end: GeoPoint,
  departAt: Minutes
): SimResult {
  if (stops.length === 0) {
    return {
      order: [],
      arriveAt: {},
      violations: [],
      softViolations: [],
      driveKm: 0,
      homeKm: distKm(start, end),
      endAt: departAt + travelMinutes(distKm(start, end)),
      feasible: true,
    };
  }

  const byDistance = run(start, orderStops(start, stops, end), end, departAt);
  if (byDistance.feasible && stops.length <= 2) return byDistance;

  const byDeadline = run(start, deadlineFirst(stops), end, departAt);

  if (byDeadline.violations.length < byDistance.violations.length) return byDeadline;
  if (byDeadline.violations.length > byDistance.violations.length) return byDistance;
  return byDeadline.driveKm + byDeadline.homeKm < byDistance.driveKm + byDistance.homeKm
    ? byDeadline
    : byDistance;
}
