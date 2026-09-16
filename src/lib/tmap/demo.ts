/**
 * Demo Mode (FR-34 / PRD §2.3)
 *
 * 경유지 최적화 API는 하루 50건이 전부다. 개발·시연 중 버튼을 몇 번만 눌러도
 * 당일 운영분이 사라지므로, API를 전혀 부르지 않고 전 과정을 돌리는 모드를 둔다.
 *
 * 좌표는 시·군 중심점 + 주소 해시 기반의 결정적(deterministic) 산포로 만든다.
 * 같은 주소는 항상 같은 좌표가 나오므로 결과가 재현된다.
 */

import type { GeoResult } from "@/lib/domain/types";

/** 시·군 중심 좌표 — 실데이터에 등장하는 권역 전부 */
const REGION_CENTROIDS: Record<string, [number, number]> = {
  평택: [36.9924, 127.1128],
  하남: [37.5393, 127.2148],
  용인: [37.2411, 127.1776],
  인천: [37.4563, 126.7052],
  시흥: [37.38, 126.8029],
  이천: [37.2722, 127.435],
  화성: [37.1996, 126.831],
  수원: [37.2636, 127.0286],
  안성: [37.008, 127.2797],
  오산: [37.1499, 127.0773],
  천안: [36.8151, 127.1139],
  서울: [37.5665, 126.978],
  의왕: [37.3448, 126.9683],
  안산: [37.3219, 126.8309],
  성남: [37.42, 127.1267],
  김포: [37.6152, 126.7156],
  고양: [37.6584, 126.832],
  광주: [37.4293, 127.255],
  남양주: [37.636, 127.2165],
  구리: [37.5943, 127.1296],
  아산: [36.7898, 127.0018],
  익산: [35.9483, 126.9577],
  청주: [36.6424, 127.489],
};

/** 주소 문자열에서 시·군을 추출한다 */
export function regionOfAddress(address: string): string | null {
  const a = address.replace(/\s+/g, "");
  for (const key of Object.keys(REGION_CENTROIDS)) {
    if (a.includes(key)) return key;
  }
  return null;
}

/**
 * 권역 토큰에서 시·군만 남긴다.
 * 실데이터의 권역 토큰에는 세부 지점이 붙어 있다 —
 * `광주-문형산안길`, `광주새말길(2창고)`, `이천(양녕로)`, `시흥-3106번길`, `서울 제기동`.
 * 이 표기를 그대로 사전 키로 쓰면 전부 미스가 난다.
 */
function centroidKeyOf(region: string): string | null {
  const stripped = region
    .replace(/\([^)]*\)/g, "")
    .split(/[-–—\s]/)[0]
    .replace(/\s+/g, "")
    .trim();
  if (REGION_CENTROIDS[stripped]) return stripped;
  // `광주새말길`처럼 시·군명에 바로 붙은 경우 접두 일치로 찾는다
  for (const key of Object.keys(REGION_CENTROIDS)) {
    if (stripped.startsWith(key)) return key;
  }
  return null;
}

/** FNV-1a 32bit — 같은 입력에 항상 같은 값 */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** -1 ~ 1 사이의 결정적 난수 */
function jitter(seed: string, salt: string): number {
  const h = hash32(`${seed}#${salt}`);
  return (h % 20000) / 10000 - 1;
}

/**
 * Demo Mode 지오코딩 — 실제 API를 부르지 않는다.
 * 시·군 중심에서 약 ±0.06도(≈ 5~7km) 범위로 흩는다.
 */
export function demoGeocode(address: string, regionHint?: string): GeoResult | null {
  const region =
    (regionHint ? centroidKeyOf(regionHint) : null) ?? regionOfAddress(address);
  const centroid = region ? REGION_CENTROIDS[region] : null;
  if (!centroid) return null;

  const [lat, lon] = centroid;
  return {
    lat: Number((lat + jitter(address, "lat") * 0.06).toFixed(6)),
    lon: Number((lon + jitter(address, "lon") * 0.06).toFixed(6)),
    source: "demo",
    queriedAddress: address,
    matchedRoadName: region ?? undefined,
  };
}

/** Demo Mode 실도로 거리 — 직선거리에 도로 우회 계수를 곱한다 */
export const DEMO_ROAD_FACTOR = 1.35;

/** Demo Mode 평균 주행 속도 (km/h) — 화물차 기준 보수적 값 */
export const DEMO_SPEED_KMH = 42;
