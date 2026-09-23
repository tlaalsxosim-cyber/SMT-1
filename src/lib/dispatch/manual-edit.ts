/**
 * 배차 보드 수동 조정 (2026-09-18 현업 피드백 — "배차가 마음에 안 들면 드래그로 옮길 수 있게")
 *
 * 자동 배차 결과를 사람이 드래그로 뒤집을 수 있게 한다. 회전 하나의 배송지 구성이
 * 바뀌면 그 회전의 순서·거리·도착시각을 **직선거리 근사로 다시 계산**한다 — 서버의
 * `pipeline/run.ts`가 쓰는 `simulateTrip` + `applyWaiting`을 그대로 재사용한다
 * (거리 계산 단일 진입점 원칙, FR-44). TMAP 실도로 값으로 재확정하려면 배차를
 * 다시 실행해야 한다.
 *
 * 수동 조정은 사람의 판단이 자동 배차 점수보다 우선이라는 전제다. 그래서 여기서는
 * 적재 상한·업체 수 상한 위반을 막지 않는다 — 화면에서 경고로만 보여주고 진행은
 * 허용한다.
 */

import { autoSiteGroup } from "@/lib/domain/constants";
import type { GeoResult, Minutes, Stop, UnassignedItem, Vehicle } from "@/lib/domain/types";
import { isWithin } from "@/lib/structure/time-window";
import { simulateTrip, type SimStop } from "./feasibility";
import { applyWaiting } from "./waiting";

export interface RecomputedTrip {
  stops: Stop[];
  boxes: number;
  loadRate: number;
  driveKm: number;
  homeKm: number;
  homeAt: Minutes | null;
}

/**
 * 회전의 배송지 구성이 바뀐 뒤 순서·도착시각·거리를 다시 계산한다.
 * 2회전 이상 차량의 앞 회전을 건드리면 다음 회전 출발 시각(재상차 이후)은
 * 다시 계산하지 않는다 — 화면에서 "다음 회전 출발시각을 다시 확인하십시오"로 안내한다.
 */
export function recomputeTrip(
  stops: Stop[],
  vehicle: Vehicle,
  tripNo: number,
  departAt: Minutes,
  centerGeo: GeoResult
): RecomputedTrip {
  const boxes = stops.reduce((s, x) => s + x.boxes, 0);
  const loadRate = vehicle.최대수량 > 0 ? boxes / vehicle.최대수량 : 0;

  if (stops.length === 0) {
    return { stops: [], boxes: 0, loadRate: 0, driveKm: 0, homeKm: 0, homeAt: null };
  }

  const isFinalTrip = tripNo === vehicle.회전수;
  const endGeo = isFinalTrip ? vehicle.arrivalGeo ?? centerGeo : centerGeo;

  const withGeo = stops.filter((s) => !!s.geo);
  const simStops: SimStop[] = withGeo.map((s) => ({
    id: s.pointId,
    geo: s.geo!,
    windows: s.windows,
    advisory: false,
  }));

  const sim = simulateTrip(centerGeo, simStops, endGeo, departAt);
  const waiting = applyWaiting(
    withGeo.map((s) => ({ id: s.pointId, windows: s.windows })),
    sim.arriveAt
  );

  const byId = new Map(stops.map((s) => [s.pointId, s]));
  const ordered = sim.order.map((id) => byId.get(id)).filter((s): s is Stop => !!s);
  // 좌표가 없는 배송지(있어서는 안 되지만 방어적으로)는 끝에 그대로 붙인다
  for (const s of stops) if (!ordered.includes(s)) ordered.push(s);

  const newStops: Stop[] = ordered.map((s, i) => {
    const arriveAt = waiting.arriveAt[s.pointId] ?? null;
    return {
      ...s,
      seq: i + 1,
      arriveAt,
      timeOk: arriveAt === null ? null : isWithin(s.windows, arriveAt),
    };
  });

  return {
    stops: newStops,
    boxes,
    loadRate,
    driveKm: sim.driveKm,
    homeKm: sim.homeKm,
    homeAt: sim.endAt,
  };
}

/** 미배차 항목을 회전에 끌어넣을 때 Stop으로 변환한다 */
export function unassignedToStop(u: UnassignedItem): Stop {
  return {
    seq: 0,
    pointId: u.pointId,
    company: u.company,
    region: u.region,
    address: u.address,
    boxes: u.boxes,
    tags: u.tags ?? [],
    maxTonnage: u.maxTonnage ?? null,
    pallets: u.pallets ?? null,
    hasExplicitStart: u.hasExplicitStart ?? false,
    timeRaw: u.timeRaw,
    windows: u.windows ?? [],
    arriveAt: null,
    timeOk: null,
    contact: u.contact ?? null,
    geo: u.geo,
    manual: true,
    출고장소코드: u.출고장소코드,
    출고장소: u.출고장소,
    siteGroup: u.siteGroup,
  };
}

/** 회전에서 뺀 배송지를 기타(미배차) 항목으로 변환한다 */
export function stopToUnassigned(s: Stop): UnassignedItem {
  return {
    pointId: s.pointId,
    company: s.company,
    region: s.region,
    address: s.address,
    boxes: s.boxes,
    timeRaw: s.timeRaw,
    reason: "수동조정",
    note: "담당자가 배차 보드에서 수동으로 미배차 처리했습니다",
    geo: s.geo,
    windows: s.windows,
    tags: s.tags,
    maxTonnage: s.maxTonnage,
    hasExplicitStart: s.hasExplicitStart,
    contact: s.contact,
    출고장소코드: s.출고장소코드,
    출고장소: s.출고장소,
    siteGroup: s.siteGroup ?? autoSiteGroup(s.출고장소코드),
  };
}
