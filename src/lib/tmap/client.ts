/**
 * TMAP API 클라이언트 (FR-20 ~ FR-35 / PRD §2)
 *
 * **서버 전용 모듈** — 브라우저에서 직접 부르면 CORS에 막히고 App Key가 노출된다.
 * 모든 호출은 Next.js route handler(서버)에서만 일어난다 (FR-31 / NFR-03).
 *
 * 주의할 점 세 가지 (PRD §2.2에서 반복해 지적된 실수)
 *   1. 좌표 순서 — 요청 Body는 X=경도, Y=위도. 응답 LineString도 [경도, 위도].
 *   2. 지오코딩 좌표 필드 — 도로명이면 newLat/newLon, 지번이면 lat/lon.
 *      배송 실무에는 건물 입구 newLatEntr/newLonEntr를 우선한다.
 *   3. startTime은 yyyyMMddHHmm **12자리**. 축약하면 400이 떨어진다.
 */

import "server-only";

import { CENTER, MAX_VIA_POINTS } from "@/lib/domain/constants";
import type { GeoPoint, GeoResult, Minutes } from "@/lib/domain/types";
import { demoGeocode, DEMO_ROAD_FACTOR, DEMO_SPEED_KMH } from "./demo";
import { haversineKm } from "@/lib/dispatch/distance";
import type {
  TmapGeoCoordinate,
  TmapGeoResponse,
  TmapOptimizationResponse,
  TmapRouteFeature,
  TmapRouteResponse,
} from "./types";

const BASE = "https://apis.openapi.sk.com";

export class TmapError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly hint: string
  ) {
    super(message);
    this.name = "TmapError";
  }
}

export function hasTmapKey(): boolean {
  return Boolean(process.env.TMAP_APP_KEY);
}

function appKey(): string {
  const key = process.env.TMAP_APP_KEY;
  if (!key) {
    throw new TmapError(
      "TMAP_APP_KEY 환경변수가 설정되지 않았습니다",
      0,
      "설정 탭에서 키 상태를 확인하거나 Demo Mode로 실행하십시오"
    );
  }
  return key;
}

/** 401/400을 PRD §2.4의 구분대로 안내한다 (FR-35) */
function hintFor(status: number, body: string): string {
  if (status === 401)
    return "App Key가 없거나 해당 상품이 미승인 상태입니다 — SK open API 콘솔에서 상품 사용 신청을 확인하십시오";
  if (status === 400)
    return `요청 Body 형식 오류입니다 — startTime 12자리(yyyyMMddHHmm), 좌표 X=경도/Y=위도 순서를 확인하십시오. 응답: ${body.slice(0, 200)}`;
  if (status === 429) return "일일 무료 호출 한도를 초과했습니다";
  return body.slice(0, 200);
}

async function callTmap<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; query?: Record<string, string> }
): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) url.searchParams.set(k, v);
  }

  const res = await fetch(url, {
    method: init.method,
    headers: {
      appKey: appKey(),
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) {
    throw new TmapError(
      `TMAP ${path} 호출 실패 (${res.status})`,
      res.status,
      hintFor(res.status, text)
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new TmapError(`TMAP ${path} 응답을 JSON으로 읽지 못했습니다`, res.status, text.slice(0, 200));
  }
}

// ─────────────────────────────────────────────────────────────
// ① 지오코딩 (FR-20 ~ FR-23)
// ─────────────────────────────────────────────────────────────

/** 좌표 필드 분기 — 입구 > 도로명 > 지번 순 */
function pickCoordinate(c: TmapGeoCoordinate): { lat: number; lon: number; source: GeoResult["source"] } | null {
  const tryPair = (
    lat: string | undefined,
    lon: string | undefined,
    source: GeoResult["source"]
  ) => {
    const la = Number(lat);
    const lo = Number(lon);
    if (Number.isFinite(la) && Number.isFinite(lo) && la !== 0 && lo !== 0) {
      return { lat: la, lon: lo, source };
    }
    return null;
  };

  return (
    tryPair(c.newLatEntr, c.newLonEntr, "entrance") ??
    tryPair(c.newLat, c.newLon, "road") ??
    tryPair(c.lat, c.lon, "jibun")
  );
}

export interface GeocodeOutcome {
  result: GeoResult | null;
  /** 실패했거나 확인이 필요한 이유 */
  failure: "변환실패" | "도로명불일치" | "remainder존재" | null;
  note: string;
}

export async function geocode(
  address: string,
  opts: { demo: boolean; regionHint?: string }
): Promise<GeocodeOutcome> {
  if (!address.trim()) {
    return { result: null, failure: "변환실패", note: "주소가 비어 있습니다" };
  }

  if (opts.demo) {
    const r = demoGeocode(address, opts.regionHint);
    return r
      ? { result: r, failure: null, note: "Demo Mode 좌표" }
      : { result: null, failure: "변환실패", note: "Demo Mode 권역 사전에 없는 주소입니다" };
  }

  const json = await callTmap<TmapGeoResponse>("/tmap/geo/fullAddrGeo", {
    method: "GET",
    query: {
      version: "1",
      format: "json",
      coordType: "WGS84GEO",
      fullAddr: address,
    },
  });

  const info = json.coordinateInfo;
  const total = Number(info?.totalCount ?? "0");

  // totalCount "0" = 변환 실패 (FR-22)
  if (!Number.isFinite(total) || total < 1 || !info?.coordinate?.length) {
    return { result: null, failure: "변환실패", note: `totalCount=${info?.totalCount ?? "없음"}` };
  }

  const c = info.coordinate[0];
  const picked = pickCoordinate(c);
  if (!picked) {
    return { result: null, failure: "변환실패", note: "응답에 사용할 수 있는 좌표 필드가 없습니다" };
  }

  const remainder = c.remainder?.trim() || undefined;
  const matchedRoadName = c.newRoadName ?? c.roadName ?? undefined;

  // 도로명 교차 확인 (FR-23)
  let failure: GeocodeOutcome["failure"] = null;
  let note = `${picked.source} 좌표 채택`;

  if (remainder) {
    failure = "remainder존재";
    note = `주소에 해석되지 않은 잔여 문자열이 있습니다: "${remainder}"`;
  } else if (matchedRoadName) {
    const normalized = address.replace(/\s+/g, "");
    if (!normalized.includes(matchedRoadName.replace(/\s+/g, ""))) {
      failure = "도로명불일치";
      note = `입력 주소에 없는 도로명으로 매칭되었습니다: "${matchedRoadName}"`;
    }
  }

  return {
    result: {
      lat: picked.lat,
      lon: picked.lon,
      source: picked.source,
      matchedRoadName,
      remainder,
      queriedAddress: address,
    },
    failure,
    note,
  };
}

// ─────────────────────────────────────────────────────────────
// ③ 자동차 경로안내 (FR-30)
// ─────────────────────────────────────────────────────────────

export interface RouteLeg {
  distanceKm: number;
  durationMin: number;
  source: "tmap" | "demo";
}

export async function routeBetween(
  from: GeoPoint,
  to: GeoPoint,
  opts: { demo: boolean }
): Promise<RouteLeg> {
  if (opts.demo) {
    const km = haversineKm(from, to) * DEMO_ROAD_FACTOR;
    return {
      distanceKm: Number(km.toFixed(2)),
      durationMin: Math.round((km / DEMO_SPEED_KMH) * 60),
      source: "demo",
    };
  }

  const json = await callTmap<TmapRouteResponse>("/tmap/routes", {
    method: "POST",
    query: { version: "1", format: "json" },
    body: {
      // X=경도, Y=위도 — 순서 주의
      startX: from.lon,
      startY: from.lat,
      endX: to.lon,
      endY: to.lat,
      reqCoordType: "WGS84GEO",
      resCoordType: "WGS84GEO",
      searchOption: "0",
      trafficInfo: "N",
    },
  });

  const props = json.features?.[0]?.properties;
  const meters = props?.totalDistance ?? 0;
  const seconds = props?.totalTime ?? 0;

  return {
    // 화면에는 항상 km·분으로 변환해 표시한다
    distanceKm: Number((meters / 1000).toFixed(2)),
    durationMin: Math.round(seconds / 60),
    source: "tmap",
  };
}

// ─────────────────────────────────────────────────────────────
// ⑤ 경유지 최적화 (FR-24, FR-25)
// ─────────────────────────────────────────────────────────────

export interface ViaPoint {
  id: string;
  name: string;
  geo: GeoPoint;
}

export interface OptimizeInput {
  /** 회전 출발 시각 */
  departAt: Minutes;
  date: string; // YYYYMMDD
  start: { name: string; geo: GeoPoint };
  /** 도착지 = 기사 거주지 — 귀가 구간까지 최적화에 포함시킨다 */
  end: { name: string; geo: GeoPoint };
  vias: ViaPoint[];
}

export interface OptimizeOutput {
  /** 최적 방문 순서대로 정렬된 경유지 id */
  order: string[];
  /** 경유지 id → 도착 예정 시각(분) */
  arriveAt: Record<string, Minutes>;
  totalDistanceKm: number;
  totalTimeMin: number;
  source: "tmap" | "demo";
}

/** `yyyyMMddHHmm` 12자리 — 축약하면 400 (FR-27) */
export function formatStartTime(date: string, minutes: Minutes): string {
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");
  return `${date}${h}${m}`;
}

function parseArriveTime(raw: string | undefined): Minutes | null {
  if (!raw) return null;
  // `yyyyMMddHHmmss` 또는 `yyyy-MM-dd HH:mm:ss`
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 12) return null;
  const h = Number(digits.slice(8, 10));
  const m = Number(digits.slice(10, 12));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

export async function optimizeRoute(input: OptimizeInput, opts: { demo: boolean }): Promise<OptimizeOutput> {
  if (input.vias.length === 0) {
    return { order: [], arriveAt: {}, totalDistanceKm: 0, totalTimeMin: 0, source: opts.demo ? "demo" : "tmap" };
  }
  if (input.vias.length > MAX_VIA_POINTS) {
    throw new TmapError(
      `경유지가 ${input.vias.length}개로 상한(${MAX_VIA_POINTS})을 넘었습니다`,
      0,
      "회전 조합을 다시 나누십시오"
    );
  }

  if (opts.demo) return demoOptimize(input);

  const json = await callTmap<TmapOptimizationResponse>("/tmap/routes/routeOptimization10", {
    method: "POST",
    query: { version: "1", format: "json" },
    body: {
      startName: input.start.name,
      startX: String(input.start.geo.lon),
      startY: String(input.start.geo.lat),
      startTime: formatStartTime(input.date, input.departAt),
      endName: input.end.name,
      endX: String(input.end.geo.lon),
      endY: String(input.end.geo.lat),
      reqCoordType: "WGS84GEO",
      resCoordType: "WGS84GEO",
      searchOption: "0",
      viaPoints: input.vias.map((v, i) => ({
        viaPointId: v.id,
        viaPointName: v.name.slice(0, 50),
        viaX: String(v.geo.lon),
        viaY: String(v.geo.lat),
        viaTime: 600, // 하차 체류 시간(초) — 파라미터 보정 대상 (OI-8)
        viaDetailAddress: "",
        idx: i,
      })),
    },
  });

  if (json.error) {
    throw new TmapError(
      `경유지 최적화 실패: ${json.error.message ?? json.error.id}`,
      200,
      "경유지 좌표와 startTime 형식을 확인하십시오"
    );
  }

  // pointType "B1" Feature의 등장 순서 = 최적 방문 순서 (FR-25)
  const order: string[] = [];
  const arriveAt: Record<string, Minutes> = {};

  for (const f of json.features ?? []) {
    const p = f.properties;
    if (!p || p.pointType !== "B1") continue;
    const id = p.viaPointId ?? p.viaPointName;
    if (!id || order.includes(id)) continue;
    order.push(id);
    const at = parseArriveTime(p.arriveTime);
    if (at !== null) arriveAt[id] = at;
  }

  // 응답에 B1이 없으면 입력 순서를 그대로 쓰되 경고를 남길 수 있게 빈 order를 반환하지 않는다
  const finalOrder = order.length ? order : input.vias.map((v) => v.id);

  return {
    order: finalOrder,
    arriveAt,
    totalDistanceKm: Number(((json.properties?.totalDistance ?? 0) / 1000).toFixed(2)),
    totalTimeMin: Math.round((json.properties?.totalTime ?? 0) / 60),
    source: "tmap",
  };
}

/**
 * Demo Mode 최적화 — 최근접 이웃 + 2-opt.
 * 경유지가 최대 5개라 완전탐색도 가능하지만, 실제 API와 같은 형태의
 * "근사 최적" 결과를 돌려주는 편이 검증에 유리하다.
 */
function demoOptimize(input: OptimizeInput): OptimizeOutput {
  const pts = input.vias;
  const remaining = [...pts];
  const ordered: ViaPoint[] = [];
  let cursor: GeoPoint = input.start.geo;

  while (remaining.length) {
    let best = 0;
    let bestKm = Infinity;
    remaining.forEach((p, i) => {
      const km = haversineKm(cursor, p.geo);
      if (km < bestKm) {
        bestKm = km;
        best = i;
      }
    });
    const [picked] = remaining.splice(best, 1);
    ordered.push(picked);
    cursor = picked.geo;
  }

  // 2-opt — 귀가 구간을 포함한 총 거리를 줄인다
  const totalOf = (seq: ViaPoint[]): number => {
    let km = 0;
    let prev: GeoPoint = input.start.geo;
    for (const p of seq) {
      km += haversineKm(prev, p.geo);
      prev = p.geo;
    }
    return km + haversineKm(prev, input.end.geo);
  };

  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < ordered.length - 1; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const candidate = [...ordered];
        const slice = candidate.slice(i, j + 1).reverse();
        candidate.splice(i, j - i + 1, ...slice);
        if (totalOf(candidate) < totalOf(ordered) - 1e-9) {
          ordered.splice(0, ordered.length, ...candidate);
          improved = true;
        }
      }
    }
  }

  // 도착 예정 시각 산출 — 주행 + 하차 20분
  const arriveAt: Record<string, Minutes> = {};
  let clock = input.departAt;
  let prev: GeoPoint = input.start.geo;
  let totalKm = 0;

  for (const p of ordered) {
    const km = haversineKm(prev, p.geo) * DEMO_ROAD_FACTOR;
    totalKm += km;
    clock += Math.round((km / DEMO_SPEED_KMH) * 60);
    arriveAt[p.id] = clock;
    clock += 20; // 하차 체류
    prev = p.geo;
  }
  const homeKm = haversineKm(prev, input.end.geo) * DEMO_ROAD_FACTOR;
  totalKm += homeKm;
  clock += Math.round((homeKm / DEMO_SPEED_KMH) * 60);

  return {
    order: ordered.map((p) => p.id),
    arriveAt,
    totalDistanceKm: Number(totalKm.toFixed(2)),
    totalTimeMin: clock - input.departAt,
    source: "demo",
  };
}

// ─────────────────────────────────────────────────────────────
// ④ 다중 경유지 — 확정 순서의 경로선 (FR-27)
// ─────────────────────────────────────────────────────────────

export interface SequentialOutput {
  /** 지도에 그릴 경로선. [위도, 경도] 순으로 뒤집어서 반환한다 (FR-28) */
  path: [number, number][];
  legs: { viaPointId: string; arriveAt: Minutes | null; distanceKm: number; durationMin: number }[];
  totalDistanceKm: number;
  totalTimeMin: number;
  source: "tmap" | "demo";
}

export async function sequentialRoute(
  input: OptimizeInput,
  opts: { demo: boolean }
): Promise<SequentialOutput> {
  if (opts.demo) {
    const path: [number, number][] = [
      [input.start.geo.lat, input.start.geo.lon],
      ...input.vias.map((v) => [v.geo.lat, v.geo.lon] as [number, number]),
      [input.end.geo.lat, input.end.geo.lon],
    ];
    let clock = input.departAt;
    let prev: GeoPoint = input.start.geo;
    let totalKm = 0;
    const legs = input.vias.map((v) => {
      const km = haversineKm(prev, v.geo) * DEMO_ROAD_FACTOR;
      const min = Math.round((km / DEMO_SPEED_KMH) * 60);
      totalKm += km;
      clock += min;
      const at = clock;
      clock += 20;
      prev = v.geo;
      return { viaPointId: v.id, arriveAt: at, distanceKm: Number(km.toFixed(2)), durationMin: min };
    });
    const homeKm = haversineKm(prev, input.end.geo) * DEMO_ROAD_FACTOR;
    totalKm += homeKm;
    clock += Math.round((homeKm / DEMO_SPEED_KMH) * 60);
    return {
      path,
      legs,
      totalDistanceKm: Number(totalKm.toFixed(2)),
      totalTimeMin: clock - input.departAt,
      source: "demo",
    };
  }

  const json = await callTmap<TmapRouteResponse>("/tmap/routes/routeSequential30", {
    method: "POST",
    query: { version: "1", format: "json" },
    body: {
      startName: input.start.name,
      startX: String(input.start.geo.lon),
      startY: String(input.start.geo.lat),
      startTime: formatStartTime(input.date, input.departAt),
      endName: input.end.name,
      endX: String(input.end.geo.lon),
      endY: String(input.end.geo.lat),
      reqCoordType: "WGS84GEO",
      resCoordType: "WGS84GEO",
      searchOption: "0",
      viaPoints: input.vias.map((v, i) => ({
        viaPointId: v.id,
        viaPointName: v.name.slice(0, 50),
        viaX: String(v.geo.lon),
        viaY: String(v.geo.lat),
        idx: i,
      })),
    },
  });

  const path: [number, number][] = [];
  const legs: SequentialOutput["legs"] = [];
  let totalDistance = 0;
  let totalTime = 0;

  for (const f of json.features ?? []) {
    collectLineString(f, path);

    const p = f.properties;
    if (!p) continue;
    if (p.totalDistance) totalDistance = p.totalDistance;
    if (p.totalTime) totalTime = p.totalTime;
    if (p.pointType === "B1" && p.viaPointId) {
      legs.push({
        viaPointId: p.viaPointId,
        arriveAt: parseArriveTime(p.arriveTime),
        distanceKm: Number(((p.distance ?? 0) / 1000).toFixed(2)),
        durationMin: Math.round((p.time ?? 0) / 60),
      });
    }
  }

  return {
    path,
    legs,
    totalDistanceKm: Number((totalDistance / 1000).toFixed(2)),
    totalTimeMin: Math.round(totalTime / 60),
    source: "tmap",
  };
}

/** 응답은 [경도, 위도] — 지도 라이브러리는 (위도, 경도)라서 반전 필수 (FR-28) */
function collectLineString(f: TmapRouteFeature, out: [number, number][]): void {
  const g = f.geometry;
  if (g?.type !== "LineString" || !Array.isArray(g.coordinates)) return;
  for (const pair of g.coordinates as number[][]) {
    if (Array.isArray(pair) && pair.length >= 2) {
      const [lon, lat] = pair;
      out.push([lat, lon]);
    }
  }
}

/** 센터 좌표 확보 — 실패 시 폴백 좌표를 쓴다 */
export async function resolveCenter(opts: { demo: boolean; address?: string }): Promise<GeoResult> {
  const address = opts.address?.trim() || CENTER.address;
  try {
    const r = await geocode(address, { demo: opts.demo, regionHint: "평택" });
    if (r.result) return r.result;
  } catch {
    // 폴백으로 내려간다
  }
  return {
    ...CENTER.fallback,
    source: "manual",
    queriedAddress: address,
    matchedRoadName: "폴백 좌표",
  };
}
