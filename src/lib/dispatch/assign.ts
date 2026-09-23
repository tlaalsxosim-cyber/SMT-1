/**
 * 자체 배차 로직 — 차량 간 배분 (PRD §4 / §6 / FR-40 ~ FR-44)
 *
 * TMAP은 "차량 한 대 안의 방문 순서"만 정한다. **어느 차량이 어디를 가는가**는 여기서 정한다.
 *
 * 알고리즘 개요
 *   1. 전처리 — 좌표 없는 배송지 제외(R-13), 다회전 차량 전용 분할(R-06),
 *      같은 주소 배송지 하드 묶음(R-20), 조기납품 판정(R-08)
 *   2. 회전 슬롯 생성 — 적재 상한이 큰 차량부터, 같은 차량은 회전 순서대로
 *   3. 슬롯마다 모든 후보를 씨앗으로 삼아 클러스터를 키워 보고 가장 효율적인 조합을 채택
 *      — 후보를 붙일 때 1순위는 같은 권역, 2순위는 거리로 근사한 권역 주변(R-07)
 *   4. 각 조합은 직선거리 근사로 시간 실현성을 검증(FR-30) — 최종 검증은 TMAP arriveTime
 *   5. 남은 물량은 사유 코드와 함께 기타로 이관(R-12, FR-43)
 *
 * 구현 결정 (PRD §2.2 ⑤와 다른 부분 — 문서화 필요)
 *   PRD는 모든 회전의 도착지를 기사 거주지로 지정한다. 그러나 2회전 차량의 1회전은
 *   재상차를 위해 센터로 복귀해야 하므로(R-09), **마지막 회전만 도착지를 기사 거주지로,
 *   그 앞 회전은 센터로** 둔다. 이렇게 해야 귀가 거리와 2회전 출발 시각이 모두 맞는다.
 *
 * R-06 분할 정책 (현업 확정 2026-09-18)
 *   기본은 **한 차량에 한 업체 물량 전부**다. 회전수 2 이상인 차량 한 대를 찾아 그 차량의
 *   회전에 걸쳐서만 나눠 싣고, 조각이 다른 차량으로 넘어가는 일은 없다. 그런 차량이 없으면
 *   R-18처럼 쪼개지 않고 통째로 기타에 남긴다 — "분할잔여"가 구조적으로 발생하지 않게 한다.
 */

import {
  autoSiteGroup,
  DEFAULT_DEPART_MINUTES,
  EARLY_DELIVERY_RULES,
  LARGE_VEHICLE_TONNAGE,
  MAX_CLUSTER_SPREAD_KM,
  METRO_SOUTH_LIMIT_LAT,
  RELOAD_MINUTES,
  SECOND_TRIP_MIN_DEADLINE,
  type EarlyDeliveryMode,
} from "@/lib/domain/constants";
import type {
  DeliveryPoint,
  GeoPoint,
  Issue,
  Minutes,
  UnassignedItem,
  UnassignedReason,
  Vehicle,
} from "@/lib/domain/types";
import { normalizeRegion, siteKey } from "@/lib/structure/delivery-name";
import { earliestDeadline, latestDeadline, windowSpan } from "@/lib/structure/time-window";
import { distKm } from "./distance";
import { simulateTrip, type SimResult, type SimStop } from "./feasibility";

// ─────────────────────────────────────────────────────────────
// 입출력
// ─────────────────────────────────────────────────────────────

export interface AssignOptions {
  centerGeo: GeoPoint;
  departAt?: Minutes;
  earlyMode?: EarlyDeliveryMode;
  /** 2회전 이상 회전에 배정할 수 있는 최소 마감 시각 (R-15). 기본 15:00 */
  secondTripMinDeadline?: Minutes;
  /** 센터에서 이 거리(km)를 넘으면 원거리로 분류한다 */
  farThresholdKm?: number;
  /** 같은 회전에 묶을 때 이미 담긴 배송지 중 가장 가까운 곳과의 거리(km) 상한 (R-07) */
  maxClusterSpreadKm?: number;
}

export interface PlannedTrip {
  vehicle: Vehicle;
  tripNo: number;
  isFinalTrip: boolean;
  endGeo: GeoPoint;
  endName: string;
  departAt: Minutes;
  points: DeliveryPoint[];
  sim: SimResult;
  boxes: number;
}

export interface AssignResult {
  trips: PlannedTrip[];
  unassigned: UnassignedItem[];
  /** 좌표가 없어 배차 대상에서 빠진 배송지 */
  geoMissing: DeliveryPoint[];
  issues: Issue[];
  /** 분할로 만들어진 조각을 포함한 최종 배차 단위 */
  workingPoints: DeliveryPoint[];
}

// ─────────────────────────────────────────────────────────────
// 전처리
// ─────────────────────────────────────────────────────────────

/** 조기납품 판정 (R-08 / OI-2) */
export function isEarlyDelivery(p: DeliveryPoint, mode: EarlyDeliveryMode): boolean {
  if (p.time.windows.length === 0) return false;
  const rule = EARLY_DELIVERY_RULES[mode];
  const meta = { hasExplicitStart: p.time.hasExplicitStart };
  return p.time.windows.some((w) => rule.test(w, meta));
}

/**
 * 2회전 이상 회전에 배정 가능한 배송지인지 (R-15)
 *
 * 센터 복귀 → 재상차 → 재출발하는 회전은 실제 하차가 정오를 넘긴다.
 * 마감이 임계값보다 이른 배송지는 아예 후보에서 뺀다.
 * 시간 제약이 없는 배송지는 언제든 갈 수 있으므로 허용한다.
 */
export function allowedOnSecondTrip(p: DeliveryPoint, minDeadline: Minutes): boolean {
  const deadline = latestDeadline(p.time.windows);
  if (deadline === null) return true;
  return deadline >= minDeadline;
}

/**
 * 초과 물량을 몇 조각으로 나눌지 계산한다 (R-06).
 * 차량 한 대의 회전 수(`maxChunks`)로 다 못 나누면 null — 그 차량은 후보가 아니다.
 * 예) 1,373박스를 최대수량 1,200·회전수 2인 차량에 → [1200, 173]
 */
export function splitChunkSizes(
  boxes: number,
  capacity: number,
  maxChunks: number
): number[] | null {
  const chunks: number[] = [];
  let left = boxes;
  while (left > 0) {
    if (chunks.length >= maxChunks) return null;
    const take = Math.min(left, capacity);
    chunks.push(take);
    left -= take;
  }
  return chunks;
}

function makeSplitChunk(p: DeliveryPoint, boxes: number, index: number, vehicleId: string): DeliveryPoint {
  return { ...p, id: `${p.id}#${index}`, boxes, splitFrom: p.id, splitIndex: index, splitVehicleId: vehicleId };
}

/**
 * 다회전 분할 대상 선정 (R-06)
 *
 * 기본은 **한 차량에 한 업체 물량 전부**다. 전 차량의 최대수량을 넘는 물량만,
 * 회전수 2 이상인 차량 한 대를 찾아 그 차량의 회전에 걸쳐서만 나눠 싣는다.
 * 조각을 다른 차량 후보 풀에 흘려보내지 않는다 — 그래야 조각이 흩어지거나
 * 실을 회전이 안 남는 "분할잔여"가 구조적으로 생기지 않는다.
 * 맞는 차량이 없으면(또는 이미 다른 초과 물량이 그 차량을 쓰고 있으면) R-18처럼
 * 쪼개지 않고 통째로 남겨 기타에서 사유와 함께 보여 준다.
 */
function reserveMultiTripSplits(
  points: DeliveryPoint[],
  vehicles: Vehicle[],
  maxCapacity: number,
  secondTripMinDeadline: Minutes
): { points: DeliveryPoint[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const hostOrder = [...vehicles]
    .filter((v) => v.회전수 >= 2)
    .sort((a, b) => b.최대수량 - a.최대수량 || a.id.localeCompare(b.id));
  const usedVehicles = new Set<string>();

  const out: DeliveryPoint[] = [];
  for (const p of points) {
    if (p.boxes <= maxCapacity) {
      out.push(p);
      continue;
    }

    const host = hostOrder.find(
      (v) =>
        !usedVehicles.has(v.id) &&
        (p.maxTonnage === null || v.tonnage <= p.maxTonnage) &&
        allowedOnSecondTrip(p, secondTripMinDeadline) &&
        splitChunkSizes(p.boxes, v.최대수량, v.회전수) !== null
    );

    if (!host) {
      out.push(p);
      continue;
    }

    usedVehicles.add(host.id);
    const chunkSizes = splitChunkSizes(p.boxes, host.최대수량, host.회전수)!;
    chunkSizes.forEach((boxes, i) => out.push(makeSplitChunk(p, boxes, i + 1, host.id)));

    issues.push({
      level: "info",
      code: "R-06",
      message: `최대 적재(${host.최대수량})를 초과해 ${host.기사명} 차량 회전에 나눠 싣습니다`,
      subject: p.parsedName.company,
      detail: `${p.boxes} → ${chunkSizes.join(" + ")} (${chunkSizes.length}회전, 다른 차량으로는 넘기지 않음)`,
    });
  }

  return { points: out, issues };
}

/**
 * 대형차인지 (R-17) — 5톤 이상은 회전당 1업체가 원칙이다.
 * 2번째 업체는 첫 업체와 **주소가 거의 동일할 때만** 붙일 수 있다.
 */
export function isLargeVehicle(v: Pick<Vehicle, "tonnage">): boolean {
  return v.tonnage >= LARGE_VEHICLE_TONNAGE;
}

/**
 * 주소 묶음(R-20)을 실을 차량을 고른다 — **정적 용량만** 본다(최소수량/최소업체수
 * 하한은 검사하지 않는다. 남은 자리는 다른 후보로 채우면 된다).
 * 최대수량 오름차순으로 골라, 꼭 필요한 것보다 큰 차량을 불필요하게 점유하지 않는다.
 */
function pickSiteGroupVehicle(group: DeliveryPoint[], vehicles: Vehicle[]): Vehicle | null {
  const totalBoxes = group.reduce((s, p) => s + p.boxes, 0);
  const tonnageLimits = group.map((p) => p.maxTonnage).filter((t): t is number => t !== null);
  const tonnageLimit = tonnageLimits.length > 0 ? Math.min(...tonnageLimits) : Infinity;

  const sorted = [...vehicles].sort((a, b) => a.최대수량 - b.최대수량 || a.id.localeCompare(b.id));
  return (
    sorted.find(
      (v) => totalBoxes <= v.최대수량 && group.length <= v.최대업체수 && v.tonnage <= tonnageLimit
    ) ?? null
  );
}

/**
 * 같은 주소 배송지를 한 회전에 묶는다 (R-20, 요청 2026-09-23)
 *
 * 좌표가 사실상 같으므로 시간창을 억지로 교집합 계산할 필요가 없다 — `simulateTrip`이
 * 이미 각 배송지를 개별 Stop으로 순차 검증한다. 여기서는 "이 그룹은 항상 함께
 * 고려된다"는 원자성만 보장한다: DeliveryPoint를 하나로 합치지 않고, 그룹을 실을
 * 차량 하나를 미리 정해(`siteGroupVehicleId`) 그 차량의 후보 풀에서만 나타나게 하고,
 * `growCluster`가 씨앗을 그 그룹 전체로 확장해서 붙인다(아래 `growCluster` 참고).
 *
 * R-06 분할 조각(`splitFrom`)은 이미 특정 차량에 하드 고정돼 있어 그룹화 대상에서
 * 뺀다 — 두 하드 규칙이 얽히는 조합은 실사례가 없어 지금은 범위 밖으로 둔다.
 *
 * 그룹 전체를 실을 차량이 없으면(정적 용량조차 안 맞으면) 쪼개서 일부만 배차하지
 * 않는다 — R-06·R-18과 같은 원칙으로, 통째로 기타에 남겨 사유와 함께 보여 준다.
 */
function reserveSiteGroups(
  points: DeliveryPoint[],
  vehicles: Vehicle[]
): { points: DeliveryPoint[]; unassignedGroups: DeliveryPoint[][]; issues: Issue[] } {
  const issues: Issue[] = [];

  const bySite = new Map<string, DeliveryPoint[]>();
  for (const p of points) {
    if (p.splitFrom) continue;
    const key = siteKey(p.cleanAddress || p.address);
    if (!key) continue;
    bySite.set(key, [...(bySite.get(key) ?? []), p]);
  }

  const groupOf = new Map<string, string>();
  const vehicleOf = new Map<string, string>();
  const unassignedGroups: DeliveryPoint[][] = [];
  let idx = 0;

  for (const [address, members] of bySite) {
    if (members.length < 2) continue;
    idx += 1;
    const groupId = `SITE${idx}`;
    const names = members.map((m) => m.parsedName.company).join(", ");
    const vehicle = pickSiteGroupVehicle(members, vehicles);

    if (!vehicle) {
      unassignedGroups.push(members);
      issues.push({
        level: "warning",
        code: "R-20",
        message: `같은 주소 ${members.length}곳(${names})을 한 회전에 실을 수 있는 차량이 없어 통째로 기타로 남깁니다`,
        subject: names,
        detail: address,
      });
      continue;
    }

    for (const m of members) {
      groupOf.set(m.id, groupId);
      vehicleOf.set(m.id, vehicle.id);
    }
    issues.push({
      level: "info",
      code: "R-20",
      message: `같은 주소 ${members.length}곳(${names})을 ${vehicle.기사명} 차량 한 회전에 묶어 배정합니다`,
      subject: names,
      detail: address,
    });
  }

  const excludedIds = new Set(unassignedGroups.flat().map((m) => m.id));
  const out = points
    .filter((p) => !excludedIds.has(p.id))
    .map((p) =>
      groupOf.has(p.id)
        ? { ...p, siteGroupId: groupOf.get(p.id), siteGroupVehicleId: vehicleOf.get(p.id) }
        : p
    );

  return { points: out, unassignedGroups, issues };
}

/**
 * 권역 정규화 키 (R-07 1순위, 현업 확정 2026-09-23) — 납품처명 3번째 토큰을 시·군 단위로 정규화한 값.
 * 클러스터에 후보를 붙일 때 같은 권역을 최우선으로 삼는다. 권역 간 인접 관계 데이터가
 * 없으므로 "권역 주변"(2순위)은 거리로 근사한다 — 같은 권역 후보가 없으면 자연스럽게
 * 거리순 정렬로 넘어간다. 45km 하드 상한(R-07 본 규칙)은 그대로 유지되고, 이건 그 안의
 * 정렬 우선순위일 뿐이다(하드 필터 아님) — 권역이 갈려도 45km 이내면 여전히 후보가 된다.
 */
function regionKeyOf(p: DeliveryPoint): string {
  return normalizeRegion(p.parsedName.region);
}

/** 같은 장소인지 (R-17) — 층·도크·건물명을 뺀 주소가 같으면 같은 장소로 본다 */
export function isSameSite(a: DeliveryPoint, b: DeliveryPoint): boolean {
  const ka = siteKey(a.cleanAddress || a.address);
  if (!ka) return false;
  return ka === siteKey(b.cleanAddress || b.address);
}

/**
 * 천안 이남인지 (R-18) — 지입 배차에서 제외할 대상인지.
 * 좌표가 없으면 판정하지 않는다(북쪽 취급) — 좌표 없는 건은 R-13이 따로 걷어 낸다.
 */
export function isSouthOfMetro(p: DeliveryPoint): boolean {
  return p.geo ? p.geo.lat < METRO_SOUTH_LIMIT_LAT : false;
}

/** §6.1 배차 우선순위 — 시간창이 좁고 마감이 이른 배송지를 먼저 잡는다 */
export function priorityOf(p: DeliveryPoint): number {
  const deadline = earliestDeadline(p.time.windows);
  const urgency = deadline === null ? 0 : clamp((900 - deadline) / 600, 0, 1);
  const span = p.time.windows.length ? windowSpan(p.time.windows) : 1440;
  const tightness = clamp((480 - span) / 480, 0, 1);
  return urgency * 0.7 + tightness * 0.3;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function toSimStop(p: DeliveryPoint): SimStop {
  return {
    id: p.id,
    geo: p.geo!,
    windows: p.time.windows,
    advisory: false,
  };
}

// ─────────────────────────────────────────────────────────────
// 슬롯
// ─────────────────────────────────────────────────────────────

interface Slot {
  vehicle: Vehicle;
  tripNo: number;
  isFinalTrip: boolean;
}

function buildSlots(vehicles: Vehicle[]): Slot[] {
  const slots: Slot[] = [];
  for (const v of vehicles) {
    for (let t = 1; t <= v.회전수; t++) {
      slots.push({ vehicle: v, tripNo: t, isFinalTrip: t === v.회전수 });
    }
  }
  // 적재 상한이 큰 차량부터. 같은 차량의 회전은 반드시 순서대로 처리한다.
  return slots.sort((a, b) => {
    if (b.vehicle.최대수량 !== a.vehicle.최대수량) return b.vehicle.최대수량 - a.vehicle.최대수량;
    if (a.vehicle.id !== b.vehicle.id) return a.vehicle.id.localeCompare(b.vehicle.id);
    return a.tripNo - b.tripNo;
  });
}

// ─────────────────────────────────────────────────────────────
// 클러스터 생성
// ─────────────────────────────────────────────────────────────

interface ClusterContext {
  centerGeo: GeoPoint;
  endGeo: GeoPoint;
  departAt: Minutes;
  vehicle: Vehicle;
  /** 이 회전에 조기납품 배송지를 넣어도 되는지 (R-08) */
  allowEarly: boolean;
  earlySet: Set<string>;
  /** 2회전 이상이면 마감 하한을 적용한다 (R-15) */
  secondTripMinDeadline: Minutes | null;
  /** 같은 회전 안에서 허용하는 최대 인접 거리(km) (R-07) */
  maxSpreadKm: number;
}

interface Cluster {
  points: DeliveryPoint[];
  boxes: number;
  sim: SimResult;
  score: number;
}

/**
 * 씨앗 하나에서 출발해 제약을 지키며 배송지를 붙여 나간다.
 * 붙일 때마다 시간 실현성을 확인하고, 위반이 생기면 그 배송지는 건너뛴다.
 */
function growCluster(
  seed: DeliveryPoint,
  pool: DeliveryPoint[],
  ctx: ClusterContext
): Cluster | null {
  const { vehicle } = ctx;
  const large = isLargeVehicle(vehicle);

  /**
   * R-20 — 씨앗이 주소 묶음(R-20)의 일원이면, 풀에 남은 같은 묶음 멤버 전원을
   * 처음부터 함께 넣고 시작한다(묶음이 없으면 씨앗 혼자다 — 기존과 동일). 묶음은
   * 원자 단위다 — 뒤이은 증분 성장 루프에서는 한 명씩 붙지 않는다(아래 `feasible`
   * 필터의 `c.siteGroupId` 배제 참고).
   */
  const siteGroupSiblings = seed.siteGroupId
    ? pool.filter((p) => p.siteGroupId === seed.siteGroupId && p.id !== seed.id)
    : [];
  const chosen: DeliveryPoint[] = [seed, ...siteGroupSiblings];

  let boxes = chosen.reduce((s, p) => s + p.boxes, 0);
  if (boxes > vehicle.최대수량) return null;
  if (chosen.length > vehicle.최대업체수) return null;

  /**
   * R-08과의 충돌 가드 — 묶음 안에 조기납품 대상이 2곳 이상이면 기사당 1곳(R-08,
   * 현업 확정)을 하드 묶음으로 어기게 된다. 이런 조합은 항상 실현 불가로 두고
   * `diagnose()`가 사유를 설명하게 한다.
   */
  const earlyInGroup = chosen.filter((p) => ctx.earlySet.has(p.id)).length;
  if (earlyInGroup > 1) return null;

  /**
   * R-19 — 파렛트 누적. 담긴 배송지 중 하나라도 파렛트수를 모르면(`pallets === null`)
   * 그 뒤로는 누적값을 신뢰할 수 없으므로 더 이상 이 제약으로 막지 않는다
   * (`vehicle.palletLimit`이 있는 마스터가 아직 없어 지금은 항상 비활성이다 — OI-17).
   */
  let pallets = 0;
  let palletsKnown = true;
  for (const p of chosen) {
    if (p.pallets === null) palletsKnown = false;
    else pallets += p.pallets;
  }
  if (vehicle.palletLimit != null && palletsKnown && pallets > vehicle.palletLimit) return null;

  let earlyUsed = earlyInGroup;

  let sim = simulateTrip(ctx.centerGeo, chosen.map(toSimStop), ctx.endGeo, ctx.departAt);
  if (!sim.feasible) return null;

  const rejected = new Set<string>(chosen.map((p) => p.id));

  while (chosen.length < vehicle.최대업체수) {
    const room = vehicle.최대수량 - boxes;
    const boxesNeeded = Math.max(0, vehicle.최소수량 - boxes);
    const companiesNeeded = Math.max(0, vehicle.최소업체수 - chosen.length);

    const feasible = pool.filter((c) => {
      if (rejected.has(c.id)) return false;
      if (c.boxes > room) return false;
      if (ctx.earlySet.has(c.id) && (!ctx.allowEarly || earlyUsed >= 1)) return false;
      if (c.maxTonnage !== null && vehicle.tonnage > c.maxTonnage) return false;
      /**
       * R-17 — 대형차(5톤 이상)는 회전당 1업체가 원칙이다.
       * 2번째 업체는 **이미 담긴 업체와 주소가 거의 동일할 때만** 허용한다.
       * 이 줄이 없으면 30박스짜리가 1,000박스짜리에 얹혀 10톤 차로 나간다.
       */
      if (large && !chosen.every((x) => isSameSite(x, c))) return false;
      /** R-19 — 차량 파렛트 상한. 누적치를 아직 신뢰할 수 있을 때만(palletsKnown) 검사한다 */
      if (
        vehicle.palletLimit != null &&
        palletsKnown &&
        c.pallets !== null &&
        pallets + c.pallets > vehicle.palletLimit
      ) {
        return false;
      }
      if (ctx.secondTripMinDeadline !== null && !allowedOnSecondTrip(c, ctx.secondTripMinDeadline))
        return false;
      // 같은 납품처의 다른 분할 조각은 한 회전에 같이 싣지 않는다
      if (c.splitFrom && chosen.some((x) => x.splitFrom === c.splitFrom)) return false;
      // R-20 — 주소 묶음 멤버는 씨앗 확장으로만 들어온다. 한 명씩 붙이지 않는다
      if (c.siteGroupId) return false;
      /**
       * R-07 — 이미 담긴 배송지 **전부**와 maxSpreadKm 이내여야 후보가 된다.
       * 가장 가까운 곳만 보면(체이닝) 한 걸음씩은 가까워도 전체 회전의 양 끝은
       * 수십 km씩 벌어질 수 있다. 매 후보를 이미 담긴 전원과 대조해야 회전
       * 전체의 지리적 범위가 실제로 좁게 유지된다.
       */
      if (chosen.some((x) => distKm(x.geo!, c.geo!) > ctx.maxSpreadKm)) return false;
      return true;
    });

    if (feasible.length === 0) break;

    /**
     * 거리만 보고 붙이면 적재 하한을 못 채운 채 업체 수 상한에 먼저 닿는다.
     * (1톤 차량은 3~5개사로 140~150박스를 맞춰야 한다.)
     * 하한을 아직 못 채웠으면 "남은 자리에 균등 분배했을 때의 목표 크기"에
     * 가까운 물량을 우선하고, 하한을 채운 뒤에는 거리만 본다.
     */
    const target =
      boxesNeeded > 0
        ? companiesNeeded > 0
          ? boxesNeeded / companiesNeeded
          : boxesNeeded
        : null;

    /**
     * R-07 1순위 — 이미 담긴 배송지와 같은 권역인 후보를 먼저 붙인다.
     * 같은 권역 후보가 없으면 거리순으로 가까운 다른 권역이 그대로 2순위(권역 주변) 역할을 한다.
     */
    const chosenRegions = new Set(chosen.map(regionKeyOf));
    const regionRank = (c: DeliveryPoint) => (chosenRegions.has(regionKeyOf(c)) ? 0 : 1);

    const byDistance = [...feasible].sort(
      (a, b) =>
        regionRank(a) - regionRank(b) ||
        Math.min(...chosen.map((x) => distKm(x.geo!, a.geo!))) -
          Math.min(...chosen.map((x) => distKm(x.geo!, b.geo!)))
    );
    const distanceRank = new Map(byDistance.map((c, i) => [c.id, i]));

    let ranked = byDistance;
    if (target !== null) {
      const byFit = [...feasible].sort(
        (a, b) => Math.abs(a.boxes - target) - Math.abs(b.boxes - target)
      );
      const fitRank = new Map(byFit.map((c, i) => [c.id, i]));
      ranked = [...feasible].sort(
        (a, b) =>
          distanceRank.get(a.id)! + fitRank.get(a.id)! - (distanceRank.get(b.id)! + fitRank.get(b.id)!)
      );
    }

    const best: DeliveryPoint | null = ranked[0] ?? null;
    if (!best) break;

    const candidate = [...chosen, best];
    const candidateSim = simulateTrip(
      ctx.centerGeo,
      candidate.map(toSimStop),
      ctx.endGeo,
      ctx.departAt
    );

    if (!candidateSim.feasible) {
      rejected.add(best.id);
      continue;
    }

    chosen.push(best);
    boxes += best.boxes;
    if (best.pallets === null) palletsKnown = false;
    else pallets += best.pallets;
    if (ctx.earlySet.has(best.id)) earlyUsed += 1;
    sim = candidateSim;
    rejected.add(best.id);
  }

  // 적재 하한·업체 수 하한 검증 (R-03, R-04, R-05)
  if (boxes < vehicle.최소수량) return null;
  if (chosen.length < vehicle.최소업체수) return null;

  return {
    points: chosen,
    boxes,
    sim,
    score: scoreCluster(chosen, boxes, sim, vehicle.최대수량),
  };
}

/**
 * 조합 효율 점수 — 낮을수록 좋다.
 *
 * 1순위는 **적재율**이다. 박스당 주행거리만 보면 10톤 차량이 1,200박스짜리 대형 물량 대신
 * 가까운 소형 묶음(530박스)을 집는다. 소화하지 못한 물량은 그대로 용차 비용이 되므로,
 * 미적재 용량을 가장 무겁게 벌점 매긴다.
 * 2순위는 박스당 주행거리·공차 귀가 거리(G3)와 **권역 분산**(R-07 1순위, 현업 확정
 * 2026-09-23) — growCluster의 붙이기 순서가 같은 권역을 우선하더라도, 씨앗을 바꿔가며
 * 전체에서 가장 효율적인 조합을 고르는 이 단계에서 물리적 거리만 보면 그 우선순위가
 * 뒤집힐 수 있다. 조합에 섞인 권역 수만큼 가볍게 벌점을 줘 같은 조건이면 한 권역으로
 * 뭉친 조합이 이기게 하되, 적재율·시간창 같은 더 급한 제약은 그대로 우선한다.
 * 3순위는 마감 임박 배송지 포함 여부(§6.1).
 */
function scoreCluster(
  points: DeliveryPoint[],
  boxes: number,
  sim: SimResult,
  capacity: number
): number {
  const idleCapacity = capacity > 0 ? 1 - boxes / capacity : 1;
  const distanceCost = (sim.driveKm + 1.5 * sim.homeKm) / Math.max(1, boxes);
  const regionSpread = new Set(points.map(regionKeyOf)).size - 1;
  const priorityBonus = points.reduce((s, p) => s + priorityOf(p), 0);
  return idleCapacity + 0.5 * distanceCost + 0.15 * regionSpread - 0.05 * priorityBonus;
}

// ─────────────────────────────────────────────────────────────
// 메인
// ─────────────────────────────────────────────────────────────

export function assignDispatch(
  allPoints: DeliveryPoint[],
  vehicles: Vehicle[],
  opts: AssignOptions
): AssignResult {
  const departAtBase = opts.departAt ?? DEFAULT_DEPART_MINUTES;
  const earlyMode = opts.earlyMode ?? "endBy10";
  const secondTripMinDeadline = opts.secondTripMinDeadline ?? SECOND_TRIP_MIN_DEADLINE;
  // 수도권 끝(고양·김포 ~120km)은 정상 배송권이다. 익산(약 210km)만 걸리도록 둔다.
  const farThresholdKm = opts.farThresholdKm ?? 200;
  const maxClusterSpreadKm = opts.maxClusterSpreadKm ?? MAX_CLUSTER_SPREAD_KM;
  const issues: Issue[] = [];

  // ── 1. 전처리
  const geoMissing = allPoints.filter((p) => !p.geo);
  const geoOk = allPoints.filter((p) => p.geo);

  /**
   * R-18 — 천안 이남은 **지입 배차 대상에서 아예 뺀다**(현업 확정 2026-09-16 2차).
   * 조합 탐색에 넣고 점수로 미루는 방식은 북쪽에 대안이 없을 때 그대로 배차돼 버린다.
   * 여기서 걷어 내야 대형차가 익산·청주로 내려가지 않는다. 물량은 버리지 않고
   * 사유 「수도권외」로 기타에 남겨 용차 판단으로 넘긴다(R-12).
   */
  const southExcluded = geoOk.filter(isSouthOfMetro);
  const metroPoints = geoOk.filter((p) => !isSouthOfMetro(p));

  if (southExcluded.length > 0) {
    issues.push({
      level: "info",
      code: "R-18",
      message: `수도권 외(천안 이남) ${southExcluded.length}곳 · ${southExcluded
        .reduce((s, p) => s + p.boxes, 0)
        .toLocaleString()}박스를 지입 배차에서 제외했습니다 — 용차 대상입니다`,
      detail: southExcluded
        .map((p) => `${p.parsedName.company}(${p.parsedName.region} ${p.boxes.toLocaleString()}박스)`)
        .join(", "),
    });
  }

  const maxCapacity = Math.max(...vehicles.map((v) => v.최대수량));
  const { points: splitPoints, issues: splitIssues } = reserveMultiTripSplits(
    metroPoints,
    vehicles,
    maxCapacity,
    secondTripMinDeadline
  );
  issues.push(...splitIssues);

  // R-20 — 같은 주소 배송지는 무조건 같은 회전에 묶는다 (요청 2026-09-23)
  const {
    points: workingPoints,
    unassignedGroups: siteGroupLeftover,
    issues: siteGroupIssues,
  } = reserveSiteGroups(splitPoints, vehicles);
  issues.push(...siteGroupIssues);

  const earlySet = new Set(
    workingPoints.filter((p) => isEarlyDelivery(p, earlyMode)).map((p) => p.id)
  );
  if (earlySet.size > 0) {
    issues.push({
      level: "info",
      code: "R-08",
      message: `조기납품 배송지 ${earlySet.size}곳 — 기준: ${EARLY_DELIVERY_RULES[earlyMode].label}`,
      detail: workingPoints
        .filter((p) => earlySet.has(p.id))
        .map((p) => p.parsedName.company)
        .join(", "),
    });
  }

  // ── 2. 슬롯 순회
  const slots = buildSlots(vehicles);
  const remaining = new Map(workingPoints.map((p) => [p.id, p]));
  const trips: PlannedTrip[] = [];

  /** 차량별 다음 회전 출발 시각 — 1회전 종료 + 센터 복귀 + 재상차 (R-09) */
  const nextDepart = new Map<string, Minutes>();
  /** 기사별 조기납품 배정 횟수 (R-08: 기사당 1곳) */
  const earlyByDriver = new Map<string, number>();

  for (const slot of slots) {
    const pool = [...remaining.values()];
    if (pool.length === 0) break;

    const { vehicle } = slot;
    const departAt = nextDepart.get(vehicle.id) ?? departAtBase;

    const endGeo = slot.isFinalTrip ? (vehicle.arrivalGeo ?? opts.centerGeo) : opts.centerGeo;
    const endName = slot.isFinalTrip ? `${vehicle.기사명} 도착지` : "평택센터";

    /**
     * R-08 — 조기납품은 **기사당 1곳까지**. 회전 번호에는 제약이 없다.
     * 2회전에 조기납품을 넣어도 되는지는 규칙이 아니라 시간 실현성이 판단한다 —
     * 1회전 종료 + 센터 복귀 + 재상차 후 마감을 못 맞추면 시뮬레이터가 걸러낸다.
     */
    const allowEarly = (earlyByDriver.get(vehicle.id) ?? 0) < 1;

    /**
     * R-15 — 센터로 복귀해 재상차한 뒤 다시 나가는 회전(2회전 이상)에는
     * 마감이 이른 배송지를 배정하지 않는다. 1회전에는 적용하지 않는다.
     */
    const deadlineFloor = slot.tripNo > 1 ? secondTripMinDeadline : null;

    const ctx: ClusterContext = {
      centerGeo: opts.centerGeo,
      endGeo,
      departAt,
      vehicle,
      allowEarly,
      earlySet,
      secondTripMinDeadline: deadlineFloor,
      maxSpreadKm: maxClusterSpreadKm,
    };

    // 후보 필터 — 하드 제약을 통과하는 것만
    const large = isLargeVehicle(vehicle);
    const candidates = pool.filter((p) => {
      if (p.boxes > vehicle.최대수량) return false;
      // R-19 — 배송지 하나만으로도 차량 파렛트 상한을 넘으면 애초에 후보가 아니다
      if (vehicle.palletLimit != null && p.pallets !== null && p.pallets > vehicle.palletLimit) {
        return false;
      }
      if (p.maxTonnage !== null && vehicle.tonnage > p.maxTonnage) return false;
      /**
       * R-17 + R-03 — 대형차는 1업체가 원칙이므로, 같은 장소에 짝이 없는 소량 업체는
       * 단독으로 적재 하한을 못 채운다. 조합 탐색에 넣어 봐야 전부 버려지므로 미리 뺀다.
       */
      if (large && p.boxes < vehicle.최소수량) {
        const pair = pool.some((q) => q.id !== p.id && isSameSite(p, q));
        if (!pair) return false;
      }
      /**
       * R-06 — 다회전 분할 조각은 **예약된 차량**에서만 후보가 된다.
       * 그래야 조각이 다른 차량으로 흩어지지 않는다.
       */
      if (p.splitVehicleId && p.splitVehicleId !== vehicle.id) return false;
      /** R-20 — 같은 주소 묶음은 예약된 차량에서만 후보가 된다 (R-06과 같은 방식) */
      if (p.siteGroupVehicleId && p.siteGroupVehicleId !== vehicle.id) return false;
      if (earlySet.has(p.id) && !allowEarly) return false;
      if (deadlineFloor !== null && !allowedOnSecondTrip(p, deadlineFloor)) return false;
      return true;
    });

    if (candidates.length === 0) continue;

    // 모든 후보를 씨앗으로 삼아 가장 좋은 조합을 고른다
    let bestCluster: Cluster | null = null;
    for (const seed of candidates) {
      const cluster = growCluster(seed, candidates, ctx);
      if (!cluster) continue;
      if (!bestCluster || cluster.score < bestCluster.score) bestCluster = cluster;
    }

    if (!bestCluster) continue;

    for (const p of bestCluster.points) {
      remaining.delete(p.id);
      if (earlySet.has(p.id)) {
        earlyByDriver.set(vehicle.id, (earlyByDriver.get(vehicle.id) ?? 0) + 1);
      }
    }

    trips.push({
      vehicle,
      tripNo: slot.tripNo,
      isFinalTrip: slot.isFinalTrip,
      endGeo,
      endName,
      departAt,
      points: bestCluster.points,
      sim: bestCluster.sim,
      boxes: bestCluster.boxes,
    });

    // 다음 회전 출발 시각 — 센터 복귀 후 재상차 (R-09)
    if (!slot.isFinalTrip) {
      nextDepart.set(vehicle.id, bestCluster.sim.endAt + RELOAD_MINUTES);
    }
  }

  /**
   * 대형차가 통째로 노는 경우를 드러낸다.
   * R-17(회전당 1업체) + R-18(수도권 외 제외)이 겹치면 수도권에 적재 하한을 단독으로
   * 채우는 업체가 없어 대형차가 **구조적으로** 공차가 된다.
   * 조용히 빈 회전으로 두면 담당자가 "차가 왜 안 나갔나"를 알 수 없다.
   */
  const idleLargeVehicles = vehicles.filter(
    (v) => isLargeVehicle(v) && !trips.some((t) => t.vehicle.id === v.id)
  );
  if (idleLargeVehicles.length > 0) {
    const biggest = workingPoints.reduce((m, p) => Math.max(m, p.boxes), 0);
    issues.push({
      level: "warning",
      code: "R-17",
      message: `대형차 ${idleLargeVehicles.length}대가 공차입니다 — 수도권에 적재 하한을 단독으로 채우는 업체가 없습니다`,
      subject: idleLargeVehicles
        .map((v) => `${v.기사명}(${v.톤수라벨} 하한 ${v.최소수량.toLocaleString()}박스)`)
        .join(", "),
      detail: `수도권 최대 단일 업체 ${biggest.toLocaleString()}박스`,
    });
  }

  // ── 3. 미배차 사유 진단 (FR-43)
  const unassigned: UnassignedItem[] = [...remaining.values()].map((p) =>
    diagnose(p, vehicles, trips, {
      centerGeo: opts.centerGeo,
      earlySet,
      farThresholdKm,
      departAt: departAtBase,
      secondTripMinDeadline,
    })
  );

  // R-18 제외 건 — 사유를 분명히 적어 용차 판단으로 넘긴다
  for (const p of southExcluded) {
    unassigned.push({
      pointId: p.id,
      company: p.parsedName.company,
      region: p.parsedName.region,
      address: p.address,
      boxes: p.boxes,
      timeRaw: p.time.columnRaw ?? p.parsedName.conditionText,
      reason: "수도권외",
      note: "천안 이남이라 지입 배차에서 제외했습니다 — 용차 대상입니다 (R-18)",
      geo: p.geo,
      windows: p.time.windows,
      tags: p.tags,
      maxTonnage: p.maxTonnage,
      pallets: p.pallets,
      hasExplicitStart: p.time.hasExplicitStart,
      contact: p.contact,
      출고장소코드: p.출고장소코드,
      출고장소: p.출고장소,
      siteGroup: autoSiteGroup(p.출고장소코드),
    });
  }

  // R-20 — 같은 주소 그룹을 통째로 실을 차량이 없었던 건 (정적 용량조차 안 맞음)
  for (const group of siteGroupLeftover) {
    const names = group.map((m) => m.parsedName.company).join(", ");
    for (const p of group) {
      unassigned.push({
        pointId: p.id,
        company: p.parsedName.company,
        region: p.parsedName.region,
        address: p.address,
        boxes: p.boxes,
        timeRaw: p.time.columnRaw ?? p.parsedName.conditionText,
        reason: "주소동일잔여",
        note: `같은 주소 ${group.length}곳(${names})을 한 회전에 실을 수 있는 차량이 없어 통째로 기타로 남았습니다 (R-20)`,
        geo: p.geo,
        windows: p.time.windows,
        tags: p.tags,
        maxTonnage: p.maxTonnage,
        pallets: p.pallets,
        hasExplicitStart: p.time.hasExplicitStart,
        contact: p.contact,
        출고장소코드: p.출고장소코드,
        출고장소: p.출고장소,
        siteGroup: autoSiteGroup(p.출고장소코드),
      });
    }
  }

  for (const p of geoMissing) {
    unassigned.push({
      pointId: p.id,
      company: p.parsedName.company,
      region: p.parsedName.region,
      address: p.address,
      boxes: p.boxes,
      timeRaw: p.time.columnRaw ?? p.parsedName.conditionText,
      reason: "주소미확인",
      note: "지오코딩에 실패해 배차 대상에서 제외했습니다 — 주소확인필요 시트를 확인하십시오",
      windows: p.time.windows,
      tags: p.tags,
      maxTonnage: p.maxTonnage,
      pallets: p.pallets,
      hasExplicitStart: p.time.hasExplicitStart,
      contact: p.contact,
      출고장소코드: p.출고장소코드,
      출고장소: p.출고장소,
      siteGroup: autoSiteGroup(p.출고장소코드),
    });
  }

  return { trips, unassigned, geoMissing, issues, workingPoints };
}

// ─────────────────────────────────────────────────────────────
// 미배차 사유 진단
// ─────────────────────────────────────────────────────────────

function diagnose(
  p: DeliveryPoint,
  vehicles: Vehicle[],
  trips: PlannedTrip[],
  ctx: {
    centerGeo: GeoPoint;
    earlySet: Set<string>;
    farThresholdKm: number;
    departAt: Minutes;
    secondTripMinDeadline: Minutes;
  }
): UnassignedItem {
  const base = {
    pointId: p.id,
    company: p.parsedName.company,
    region: p.parsedName.region,
    address: p.address,
    boxes: p.boxes,
    timeRaw: p.time.columnRaw ?? p.parsedName.conditionText,
    // 담당자가 드래그로 회전에 수동 배정할 때 필요한 원본 정보 (좌표가 있어야 배정 가능)
    geo: p.geo,
    windows: p.time.windows,
    tags: p.tags,
    maxTonnage: p.maxTonnage,
    pallets: p.pallets,
    hasExplicitStart: p.time.hasExplicitStart,
    contact: p.contact,
    출고장소코드: p.출고장소코드,
    출고장소: p.출고장소,
    siteGroup: autoSiteGroup(p.출고장소코드),
  };

  const centerKm = p.geo ? distKm(ctx.centerGeo, p.geo) : 0;
  const splitNote = p.splitFrom ? ` (초과 물량 분할 ${p.splitIndex}번째 조각)` : "";

  // 원거리 — 센터에서 왕복이 비현실적. 용차 판단에 가장 직접적인 사유라 먼저 본다.
  if (centerKm > ctx.farThresholdKm) {
    return {
      ...base,
      reason: "원거리",
      note: `센터에서 약 ${Math.round(centerKm)}km — 당일 왕복이 어려워 용차 검토 대상입니다${splitNote}`,
    };
  }

  // 분할 잔여
  if (p.splitFrom) {
    return {
      ...base,
      reason: "분할잔여",
      note: `초과 물량 분할 ${p.splitIndex}번째 조각을 실을 회전이 남지 않았습니다`,
    };
  }

  /**
   * R-20 — 같은 주소 묶음이 예약된 차량까지는 배정됐지만, 그 차량의 회전 전부에서
   * 시간창·적재 등 다른 제약에 걸려 실지 못했다. 예약이 무의미해 보이지 않도록
   * 예약된 기사명을 사유에 남긴다 — "차는 놀고 있는데 왜?"에 답할 수 있어야 한다.
   */
  if (p.siteGroupVehicleId) {
    const host = vehicles.find((v) => v.id === p.siteGroupVehicleId);
    return {
      ...base,
      reason: "주소동일잔여",
      note: `같은 주소 배송지를 ${host?.기사명 ?? p.siteGroupVehicleId} 차량 한 회전에 묶어 실으려 했으나, 그 차량의 회전에서 다른 제약(시간창·적재 등)에 걸려 배정하지 못했습니다 (R-20)`,
    };
  }

  // 적재 상한 초과 — 단일 회전으로 실을 수 있는 차량이 없다
  const fits = vehicles.filter((v) => p.boxes <= v.최대수량);
  if (fits.length === 0) {
    /**
     * R-06 — 회전수 2 이상인 차량이 있었다면 다회전으로 나눠 실을 수 있었다.
     * 그런데도 통째로 남았다는 건 다른 초과 물량이 그 차량을 먼저 예약했다는 뜻이다
     * (한 차량은 초과 물량 하나만 맡는다). 사유를 분명히 알려 준다.
     */
    const splitHostExists = vehicles.some(
      (v) =>
        v.회전수 >= 2 &&
        (p.maxTonnage === null || v.tonnage <= p.maxTonnage) &&
        allowedOnSecondTrip(p, ctx.secondTripMinDeadline) &&
        splitChunkSizes(p.boxes, v.최대수량, v.회전수) !== null
    );
    if (splitHostExists) {
      return {
        ...base,
        reason: "분할잔여",
        note: `${p.boxes}박스는 2회전 이상 차량에 나눠 실어야 하지만, 그런 차량을 다른 초과 물량이 이미 쓰고 있어 배정하지 못했습니다`,
      };
    }
    return {
      ...base,
      reason: "적재상한",
      note: `${p.boxes}박스는 최대 적재 차량으로도(2회전을 동원해도) 실을 수 없습니다`,
    };
  }

  // 차량 톤수 제약
  if (p.maxTonnage !== null) {
    const allowed = fits.filter((v) => v.tonnage <= p.maxTonnage!);
    if (allowed.length === 0) {
      return {
        ...base,
        reason: "차량제약",
        note: `${p.maxTonnage}톤 이하 차량이 필요하지만 가용 차량이 없습니다`,
      };
    }
  }

  // 시간창 도달 불가 — 센터에서 출발해도 마감을 넘기는 경우
  const deadline = earliestDeadline(p.time.windows);
  if (deadline !== null && p.geo) {
    const arrive = ctx.departAt + Math.round((centerKm / 42) * 60);
    if (arrive > deadline) {
      return {
        ...base,
        reason: "시간창불가",
        note: `센터 출발 직행으로도 마감 이후 도착(예상 도착 ${Math.floor(arrive / 60)}시 ${arrive % 60}분)`,
      };
    }
  }

  /**
   * 남은 사유를 가르는 기준은 **어떤 회전이 비어 있는가**다.
   * "차는 놀고 있는데 왜 못 실었나"에 답하지 못하면 담당자는 결과를 믿지 않는다.
   */
  const usedSlots = new Set(trips.map((t) => `${t.vehicle.id}#${t.tripNo}`));
  const idleSlots: { vehicle: Vehicle; tripNo: number }[] = [];
  for (const v of vehicles) {
    for (let t = 1; t <= v.회전수; t++) {
      if (!usedSlots.has(`${v.id}#${t}`)) idleSlots.push({ vehicle: v, tripNo: t });
    }
  }
  /** 적재 상한·톤수 제약만 보면 이 업체를 받을 수 있었던 빈 회전 */
  const fitIdle = idleSlots.filter(
    (s) =>
      p.boxes <= s.vehicle.최대수량 &&
      (p.maxTonnage === null || s.vehicle.tonnage <= p.maxTonnage)
  );

  /** 업체수상한 — 적재 공간은 남았는데 그 회전이 최대업체수에 닿아 못 실은 경우 */
  const blockedByCompanyCap = trips.some((t) => {
    if (t.points.length < t.vehicle.최대업체수) return false;
    if (t.boxes + p.boxes > t.vehicle.최대수량) return false;
    if (p.maxTonnage !== null && t.vehicle.tonnage > p.maxTonnage) return false;
    if (t.tripNo > 1 && !allowedOnSecondTrip(p, ctx.secondTripMinDeadline)) return false;
    if (isLargeVehicle(t.vehicle)) return false; // R-17 — 대형차에는 얹을 수 없다
    return true;
  });

  /**
   * R-17로 막히는 빈 회전을 걷어 낸다 — 대형차는 1업체가 원칙이라
   * 적재 하한에 못 미치는 물량을 다른 업체에 얹어 채울 수 없다.
   */
  const usableIdle = fitIdle.filter(
    (s) => !(isLargeVehicle(s.vehicle) && p.boxes < s.vehicle.최소수량)
  );

  if (!blockedByCompanyCap && fitIdle.length > 0) {
    // R-17 — 빈 회전이 있긴 한데 전부 대형차라 단독으로 하한을 못 채운다
    if (usableIdle.length === 0) {
      const floor = Math.min(...fitIdle.map((s) => s.vehicle.최소수량));
      return {
        ...base,
        reason: "대형차단독",
        note:
          `남은 회전이 대형차뿐입니다. 대형차는 회전당 1업체가 원칙이라 ` +
          `적재 하한 ${floor.toLocaleString()}박스에 못 미치는 ${p.boxes.toLocaleString()}박스를 ` +
          `단독으로 실을 수 없습니다 (R-17)${splitNote}`,
      };
    }

    // R-15 — 쓸 수 있는 빈 회전이 전부 2회전 이상인데 마감이 하한보다 이르다
    if (
      usableIdle.every((s) => s.tripNo > 1) &&
      !allowedOnSecondTrip(p, ctx.secondTripMinDeadline)
    ) {
      const floor = `${String(Math.floor(ctx.secondTripMinDeadline / 60)).padStart(2, "0")}:${String(
        ctx.secondTripMinDeadline % 60
      ).padStart(2, "0")}`;
      return {
        ...base,
        reason: "시간창불가",
        note: `마감이 ${floor}보다 일러 2회전(센터 복귀 후 재출발)에 배정할 수 없고, 1회전은 모두 찼습니다${splitNote}`,
      };
    }
  }

  if (blockedByCompanyCap) {
    return {
      ...base,
      reason: "업체수상한",
      note: `적재 공간은 남았으나 회전당 업체 수 상한에 걸려 넣지 못했습니다${splitNote}`,
    };
  }

  return {
    ...base,
    reason: "회전초과",
    note: `가용 회전이 모두 소진되어 배차하지 못했습니다${splitNote}`,
  };
}

/** 사유 코드별 집계 — 화면·엑셀 요약용 */
export function summarizeReasons(items: UnassignedItem[]): Record<UnassignedReason, number> {
  const out = {} as Record<UnassignedReason, number>;
  for (const i of items) out[i.reason] = (out[i.reason] ?? 0) + i.boxes;
  return out;
}
