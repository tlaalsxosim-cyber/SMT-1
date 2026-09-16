/**
 * 거리 계산 단일 진입점 (FR-44 / PRD §7 1단계 주석)
 *
 * 1단계 프로토타입에서 거리 계산이 `distKm` 한 함수로 분리되어 있던 덕분에
 * TMAP 실도로 API로 교체하는 지점이 명확하다. 그 구조를 그대로 유지한다.
 *
 *   - 1차 후보 선정 (조합 탐색 루프 안) → 직선거리 근사. API를 부르지 않는다.
 *   - 최종 검증·표시                    → TMAP 실도로 값으로 덮어쓴다.
 *
 * 조합 탐색은 수천 번 돌기 때문에, 여기서 API를 부르면 무료 한도가 즉시 소진된다.
 */

import type { GeoPoint } from "@/lib/domain/types";

const EARTH_RADIUS_KM = 6371;

/** 두 좌표 사이 직선거리 (km) */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 배차 로직이 쓰는 거리 함수.
 * 직선거리에 수도권 도로 우회 계수를 곱해 실도로 거리를 근사한다.
 * 최종 수치는 TMAP 값으로 교체되므로 여기서는 "순위를 매길 수 있을 정도"면 충분하다.
 */
export const ROAD_DETOUR_FACTOR = 1.35;

export function distKm(a: GeoPoint, b: GeoPoint): number {
  return haversineKm(a, b) * ROAD_DETOUR_FACTOR;
}

/** 화물차 평균 주행 속도 (km/h) — 실운행 대조 후 보정 대상 (PRD §15 5단계) */
export const AVG_SPEED_KMH = 42;

/** 거리 → 소요 시간 (분) */
export function travelMinutes(km: number): number {
  return Math.round((km / AVG_SPEED_KMH) * 60);
}

/** 좌표 배열의 중심점 — 권역 묶음에 쓴다 */
export function centroid(points: GeoPoint[]): GeoPoint | null {
  if (points.length === 0) return null;
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lon = points.reduce((s, p) => s + p.lon, 0) / points.length;
  return { lat, lon };
}
