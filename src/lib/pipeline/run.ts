/**
 * E2E 배차 파이프라인 (PRD §9.1)
 *
 *   [1] 업로드·파싱·검증      [자체]        ← parse/
 *   [2] 조건 구조화           [AI]+[자체]   ← structure/
 *   [3] 좌표 변환             [TMAP 지오코딩]
 *   [4] 차량 간 배분          [자체]        ← dispatch/assign
 *   [5] 방문 순서 최적화      [TMAP 최적화]  회전당 1회
 *   [6] 시간 검증             [자체+TMAP]   위반 시 [4]로 복귀 (재시도 1회)
 *   [7] 경로 확정             [TMAP 다중경유지]
 *   [8] 결과 출력             [지도 + AI 요약 + 엑셀]
 *
 * **서버 전용.** 이 모듈이 끝나면 입력 데이터는 메모리에서 사라진다 (NFR-01).
 */

import "server-only";

import {
  CENTER,
  DEFAULT_DEPART_MINUTES,
  RETRY_LIMIT,
  SECOND_TRIP_MIN_DEADLINE,
  type EarlyDeliveryMode,
} from "@/lib/domain/constants";
import type {
  AddressIssue,
  ApiUsage,
  DeliveryPoint,
  DispatchResult,
  FleetParseResult,
  GeoResult,
  Issue,
  Minutes,
  ShipmentParseResult,
  Stop,
  Trip,
  UnassignedItem,
  Vehicle,
} from "@/lib/domain/types";
import { assignDispatch, type PlannedTrip } from "@/lib/dispatch/assign";
import { distKm } from "@/lib/dispatch/distance";
import { applyWaiting } from "@/lib/dispatch/waiting";
import { validateDispatch } from "@/lib/dispatch/validate";
import { applyAiConditions, selectForAi } from "@/lib/structure/enrich";
import { generateBriefing, hasApiKey, structureConditions, suggestAddresses } from "@/lib/structure/llm";
import { isWithin } from "@/lib/structure/time-window";
import * as counter from "@/lib/tmap/counter";
import {
  geocode,
  hasTmapKey,
  optimizeRoute,
  resolveCenter,
  sequentialRoute,
  TmapError,
  type OptimizeInput,
  type ViaPoint,
} from "@/lib/tmap/client";
import { regionOfAddress } from "@/lib/tmap/demo";

export interface RunOptions {
  demo: boolean;
  useAi: boolean;
  departAt?: Minutes;
  earlyMode?: EarlyDeliveryMode;
  /** 2회전 이상 회전의 마감 하한 (R-15). 기본 15:00 — 비교 측정용으로만 지정한다 */
  secondTripMinDeadline?: Minutes;
  centerAddress?: string;
  /** 지도 경로선까지 그릴지 — 끄면 다중경유지 호출을 건너뛴다 */
  drawRoutes?: boolean;
}

export interface RunOutput extends DispatchResult {
  /** 지도에 그릴 회전별 경로선 — [위도, 경도] */
  routePaths: Record<string, [number, number][]>;
  centerGeo: GeoResult;
  vehicles: Vehicle[];
  aiEnabled: boolean;
  tmapKeyPresent: boolean;
}

export async function runPipeline(
  ship: ShipmentParseResult,
  fleet: FleetParseResult,
  opts: RunOptions
): Promise<RunOutput> {
  const issues: Issue[] = [...ship.issues, ...fleet.issues];
  const addressIssues: AddressIssue[] = [];
  const departAt = opts.departAt ?? DEFAULT_DEPART_MINUTES;
  const earlyMode = opts.earlyMode ?? "endBy10";
  const secondTripMinDeadline = opts.secondTripMinDeadline ?? SECOND_TRIP_MIN_DEADLINE;

  if (!opts.demo && !hasTmapKey()) {
    throw new TmapError(
      "TMAP_APP_KEY가 설정되지 않았습니다",
      0,
      "환경변수를 설정하거나 Demo Mode로 실행하십시오 (설정 탭)"
    );
  }

  // ── [2] AI 조건 구조화 (규칙 결과를 보완)
  let points: DeliveryPoint[] = ship.points;
  const aiEnabled = opts.useAi && hasApiKey();

  if (aiEnabled) {
    const targets = selectForAi(points);
    const outcome = await structureConditions(targets);
    issues.push(...outcome.issues);
    if (outcome.items.length) {
      const applied = applyAiConditions(points, outcome.items);
      points = applied.points;
      issues.push(...applied.issues);
    }
  } else if (opts.useAi) {
    issues.push({
      level: "info",
      code: "FR-16",
      message: "ANTHROPIC_API_KEY가 없어 규칙 기반 해석만 사용합니다",
    });
  }

  // ── [3] 좌표 변환
  const centerGeo = await resolveCenter({ demo: opts.demo, address: opts.centerAddress });
  if (!opts.demo) counter.record("geocode");

  const vehicles = await geocodeVehicles(fleet.vehicles, opts.demo, issues, addressIssues);
  points = await geocodePoints(points, opts.demo, issues, addressIssues);

  // 지오코딩 실패분에 AI 정제 제안을 붙인다 (FR-15)
  if (aiEnabled && addressIssues.length) {
    const suggestions = await suggestAddresses(
      addressIssues.map((a) => ({
        key: a.pointId,
        company: a.company,
        rawAddress: a.rawAddress,
        queriedAddress: a.queriedAddress,
        failureNote: `${a.failureType} — ${a.note}`,
      }))
    );
    issues.push(...suggestions.issues);
    const byKey = new Map(suggestions.items.map((s) => [s.key, s]));
    for (const a of addressIssues) {
      const s = byKey.get(a.pointId);
      if (s) {
        a.suggestion = s.suggestion;
        a.note = `${a.note} · AI: ${s.reason}`;
      }
    }
  }

  // ── [4] 차량 간 배분
  const assigned = assignDispatch(points, vehicles, {
    centerGeo,
    departAt,
    earlyMode,
    secondTripMinDeadline,
  });
  issues.push(...assigned.issues);

  const unassigned: UnassignedItem[] = [...assigned.unassigned];

  // ── [5][6][7] 회전별 최적화 · 시간 검증 · 경로 확정
  const { trips, routePaths, tripIssues } = await optimizeTrips(
    assigned.trips,
    centerGeo,
    ship.date,
    unassigned,
    opts
  );
  issues.push(...tripIssues);

  // ── 결과 집계
  const assignedBoxes = trips.reduce((s, t) => s + t.boxes, 0);
  const unassignedBoxes = unassigned.reduce((s, u) => s + u.boxes, 0);

  const violations = validateDispatch({
    trips,
    vehicles,
    earlyMode,
    secondTripMinDeadline,
    totalBoxes: ship.totalBoxes,
    assignedBoxes,
    unassignedBoxes,
  });

  const apiUsage: ApiUsage = opts.demo
    ? { geocode: 0, routes: 0, sequential: 0, optimize: 0, map: 0 }
    : counter.usage();

  const result: RunOutput = {
    date: ship.date,
    trips,
    unassigned,
    addressIssues,
    totalBoxes: ship.totalBoxes,
    assignedBoxes,
    unassignedBoxes,
    usedTrips: trips.filter((t) => t.stops.length > 0).length,
    violations,
    issues,
    apiUsage,
    generatedAt: new Date().toISOString(),
    demoMode: opts.demo,
    routePaths,
    centerGeo,
    vehicles,
    aiEnabled,
    tmapKeyPresent: hasTmapKey(),
  };

  // ── [8] AI 브리핑
  if (aiEnabled) {
    const brief = await generateBriefing({
      date: ship.date,
      totalBoxes: ship.totalBoxes,
      assignedBoxes,
      unassignedBoxes,
      usedTrips: result.usedTrips,
      totalTrips: fleet.capacity.totalTrips,
      trips: trips.map((t) => ({
        기사명: t.기사명,
        톤수라벨: t.톤수라벨,
        tripNo: t.tripNo,
        boxes: t.boxes,
        loadRate: Number(t.loadRate.toFixed(3)),
        homeKm: t.homeKm,
        stops: t.stops.map((s) => ({
          company: s.company,
          region: s.region,
          boxes: s.boxes,
          arriveAt: s.arriveAt === null ? null : minutesToHHMM(s.arriveAt),
        })),
      })),
      unassigned: unassigned.map((u) => ({
        company: u.company,
        region: u.region,
        boxes: u.boxes,
        reason: u.reason,
      })),
    });
    result.briefing = brief.briefing ?? undefined;
    issues.push(...brief.issues);
  }

  return result;
}

function minutesToHHMM(m: Minutes): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

// ─────────────────────────────────────────────────────────────
// [3] 지오코딩
// ─────────────────────────────────────────────────────────────

async function geocodeVehicles(
  vehicles: Vehicle[],
  demo: boolean,
  issues: Issue[],
  addressIssues: AddressIssue[]
): Promise<Vehicle[]> {
  const out: Vehicle[] = [];

  for (const v of vehicles) {
    try {
      const r = await geocode(v.cleanArrival, {
        demo,
        regionHint: regionOfAddress(v.도착지) ?? undefined,
      });
      if (!demo) counter.record("geocode");

      if (r.result) {
        out.push({ ...v, arrivalGeo: r.result });
        if (r.failure) {
          issues.push({
            level: "warning",
            code: "FR-23",
            message: `도착지 좌표에 확인이 필요합니다 — ${r.note}`,
            subject: v.기사명,
            detail: v.도착지,
          });
        }
      } else {
        out.push(v);
        issues.push({
          level: "warning",
          code: "FR-22",
          message: "도착지 지오코딩에 실패해 귀가 거리를 센터 기준으로 계산합니다",
          subject: v.기사명,
          detail: `${v.도착지} — ${r.note}`,
        });
        addressIssues.push({
          pointId: `driver:${v.id}`,
          company: `${v.기사명} (도착지)`,
          rawAddress: v.도착지,
          queriedAddress: v.cleanArrival,
          failureType: "도착지실패",
          suggestion: null,
          note: r.note,
        });
      }
    } catch (e) {
      out.push(v);
      issues.push({
        level: "warning",
        code: "FR-22",
        message: `도착지 지오코딩 오류 — ${describeTmap(e)}`,
        subject: v.기사명,
      });
    }
  }

  return out;
}

async function geocodePoints(
  points: DeliveryPoint[],
  demo: boolean,
  issues: Issue[],
  addressIssues: AddressIssue[]
): Promise<DeliveryPoint[]> {
  const out: DeliveryPoint[] = [];

  for (const p of points) {
    try {
      let r = await geocode(p.cleanAddress, {
        demo,
        regionHint: p.parsedName.region || undefined,
      });
      if (!demo) counter.record("geocode");

      // 정제 주소로 실패하면 원문으로 한 번 더 시도한다
      if (!r.result && p.cleanAddress !== p.address) {
        r = await geocode(p.address, { demo, regionHint: p.parsedName.region || undefined });
        if (!demo) counter.record("geocode");
      }

      if (r.result) {
        out.push({ ...p, geo: r.result });
        if (r.failure) {
          addressIssues.push({
            pointId: p.id,
            company: p.parsedName.company,
            rawAddress: p.address,
            queriedAddress: r.result.queriedAddress,
            failureType: r.failure,
            suggestion: null,
            note: r.note,
          });
        }
      } else {
        out.push(p);
        addressIssues.push({
          pointId: p.id,
          company: p.parsedName.company,
          rawAddress: p.address,
          queriedAddress: p.cleanAddress,
          failureType: "변환실패",
          suggestion: null,
          note: r.note,
        });
        issues.push({
          level: "warning",
          code: "FR-22",
          message: "지오코딩에 실패해 배차 대상에서 제외했습니다",
          subject: p.parsedName.company,
          detail: p.address,
        });
      }
    } catch (e) {
      out.push(p);
      issues.push({
        level: "error",
        code: "FR-22",
        message: `지오코딩 오류 — ${describeTmap(e)}`,
        subject: p.parsedName.company,
      });
    }
  }

  return out;
}

function describeTmap(e: unknown): string {
  if (e instanceof TmapError) return `${e.message} (${e.hint})`;
  return e instanceof Error ? e.message : String(e);
}

// ─────────────────────────────────────────────────────────────
// [5][6][7] 최적화 · 시간 검증 · 경로
// ─────────────────────────────────────────────────────────────

async function optimizeTrips(
  planned: PlannedTrip[],
  centerGeo: GeoResult,
  date: string,
  unassigned: UnassignedItem[],
  opts: RunOptions
): Promise<{ trips: Trip[]; routePaths: Record<string, [number, number][]>; tripIssues: Issue[] }> {
  const tripIssues: Issue[] = [];
  const routePaths: Record<string, [number, number][]> = {};
  const trips: Trip[] = [];

  const active = planned.filter((t) => t.points.length > 0);

  // API 예산 확인 — 회전 수만큼 먼저 확보한다 (FR-32 / NFR-05)
  if (!opts.demo && active.length > 0) {
    counter.assertOptimizeBudget(active.length);
  }

  for (const t of active) {
    let workingPoints = t.points;
    let attempt = 0;
    let finalTrip: Trip | null = null;

    while (attempt <= RETRY_LIMIT) {
      const input: OptimizeInput = {
        departAt: t.departAt,
        date,
        start: { name: CENTER.name, geo: centerGeo },
        end: { name: t.endName, geo: t.endGeo },
        vias: workingPoints.map<ViaPoint>((p) => ({
          id: p.id,
          name: p.parsedName.company,
          geo: p.geo!,
        })),
      };

      let optimized;
      try {
        optimized = await optimizeRoute(input, { demo: opts.demo });
        if (!opts.demo) counter.record("optimize");
      } catch (e) {
        tripIssues.push({
          level: "warning",
          code: "FR-24",
          message: `경유지 최적화 실패 — 근사 순서를 사용합니다. ${describeTmap(e)}`,
          subject: `${t.vehicle.기사명} ${t.tripNo}회전`,
        });
        optimized = {
          order: t.sim.order,
          arriveAt: t.sim.arriveAt,
          totalDistanceKm: t.sim.driveKm + t.sim.homeKm,
          totalTimeMin: t.sim.endAt - t.departAt,
          source: "demo" as const,
        };
      }

      const built = buildTrip(t, workingPoints, optimized, centerGeo);

      // ── [6] 시간 검증 (FR-25, FR-26)
      const violators = built.stops.filter(
        (s) => s.arriveAt !== null && s.windows.length > 0 && !isWithin(s.windows, s.arriveAt)
      );

      if (violators.length === 0 || attempt === RETRY_LIMIT) {
        if (violators.length > 0) {
          // 재시도 한도를 다 썼는데도 위반이 남았다 — 위반 건을 기타로 이관한다
          const violatorIds = new Set(violators.map((v) => v.pointId));
          const kept = workingPoints.filter((p) => !violatorIds.has(p.id));

          for (const v of violators) {
            const src = workingPoints.find((p) => p.id === v.pointId)!;
            unassigned.push({
              pointId: src.id,
              company: src.parsedName.company,
              region: src.parsedName.region,
              address: src.address,
              boxes: src.boxes,
              timeRaw: src.time.columnRaw ?? src.parsedName.conditionText,
              reason: "시간창불가",
              note: `TMAP 도착예정 ${minutesToHHMM(v.arriveAt!)}이 시간창을 벗어나 제외했습니다`,
            });
            tripIssues.push({
              level: "warning",
              code: "R-11",
              message: "시간창 위반으로 기타로 이관했습니다",
              subject: `${t.vehicle.기사명} ${t.tripNo}회전 · ${v.company}`,
              detail: `도착 ${minutesToHHMM(v.arriveAt!)}`,
            });
          }

          // 남은 조합이 적재·업체 수 하한을 못 지키면 회전 전체를 취소한다 (R-04, R-05)
          const keptBoxes = kept.reduce((s, p) => s + p.boxes, 0);
          if (
            kept.length === 0 ||
            keptBoxes < t.vehicle.최소수량 ||
            kept.length < t.vehicle.최소업체수
          ) {
            for (const p of kept) {
              unassigned.push({
                pointId: p.id,
                company: p.parsedName.company,
                region: p.parsedName.region,
                address: p.address,
                boxes: p.boxes,
                timeRaw: p.time.columnRaw ?? p.parsedName.conditionText,
                reason: "적재하한미달",
                note: `같은 회전의 시간창 위반 건이 빠지면서 적재 하한(${t.vehicle.최소수량})을 채우지 못해 회전을 취소했습니다`,
              });
            }
            tripIssues.push({
              level: "warning",
              code: "R-04",
              message: "시간창 위반 제외 후 적재 하한을 못 채워 회전을 취소했습니다",
              subject: `${t.vehicle.기사명} ${t.tripNo}회전`,
            });
            finalTrip = null;
            break;
          }

          workingPoints = kept;
          const rebuilt = buildTrip(
            t,
            kept,
            { ...optimized, order: optimized.order.filter((id) => !violatorIds.has(id)) },
            centerGeo
          );
          finalTrip = rebuilt;
        } else {
          finalTrip = built;
        }
        break;
      }

      // 위반이 있고 재시도가 남았다 — 위반 건을 빼고 조합을 다시 구성한다 (R-11)
      const violatorIds = new Set(violators.map((v) => v.pointId));
      const kept = workingPoints.filter((p) => !violatorIds.has(p.id));
      const keptBoxes = kept.reduce((s, p) => s + p.boxes, 0);

      tripIssues.push({
        level: "info",
        code: "R-11",
        message: `시간창 위반 ${violators.length}건을 빼고 재최적화합니다 (재시도 ${attempt + 1}/${RETRY_LIMIT})`,
        subject: `${t.vehicle.기사명} ${t.tripNo}회전`,
        detail: violators.map((v) => v.company).join(", "),
      });

      for (const v of violators) {
        const src = workingPoints.find((p) => p.id === v.pointId)!;
        unassigned.push({
          pointId: src.id,
          company: src.parsedName.company,
          region: src.parsedName.region,
          address: src.address,
          boxes: src.boxes,
          timeRaw: src.time.columnRaw ?? src.parsedName.conditionText,
          reason: "시간창불가",
          note: `TMAP 도착예정 ${minutesToHHMM(v.arriveAt!)}이 시간창을 벗어나 제외했습니다`,
        });
      }

      if (kept.length === 0 || keptBoxes < t.vehicle.최소수량 || kept.length < t.vehicle.최소업체수) {
        for (const p of kept) {
          unassigned.push({
            pointId: p.id,
            company: p.parsedName.company,
            region: p.parsedName.region,
            address: p.address,
            boxes: p.boxes,
            timeRaw: p.time.columnRaw ?? p.parsedName.conditionText,
            reason: "적재하한미달",
            note: "시간창 위반 건 제외 후 적재 하한을 채우지 못해 회전을 취소했습니다",
          });
        }
        finalTrip = null;
        break;
      }

      workingPoints = kept;
      attempt += 1;
      if (!opts.demo) counter.assertOptimizeBudget(1);
    }

    if (!finalTrip) continue;

    // ── [7] 경로 확정 — 실도로 경로선
    if (opts.drawRoutes !== false) {
      try {
        const seq = await sequentialRoute(
          {
            departAt: t.departAt,
            date,
            start: { name: CENTER.name, geo: centerGeo },
            end: { name: t.endName, geo: t.endGeo },
            vias: finalTrip.stops.map<ViaPoint>((s) => ({
              id: s.pointId,
              name: s.company,
              geo: s.geo!,
            })),
          },
          { demo: opts.demo }
        );
        if (!opts.demo) counter.record("sequential");

        routePaths[finalTrip.id] = seq.path;
        if (seq.totalDistanceKm > 0) {
          finalTrip.driveKm = Number((seq.totalDistanceKm - finalTrip.homeKm).toFixed(2));
          finalTrip.distanceSource = seq.source === "tmap" ? "tmap" : "haversine";
        }
      } catch (e) {
        tripIssues.push({
          level: "info",
          code: "FR-27",
          message: `경로선 계산을 건너뜁니다 — ${describeTmap(e)}`,
          subject: `${t.vehicle.기사명} ${t.tripNo}회전`,
        });
      }
    }

    trips.push(finalTrip);
  }

  return { trips, routePaths, tripIssues };
}

function buildTrip(
  planned: PlannedTrip,
  points: DeliveryPoint[],
  optimized: { order: string[]; arriveAt: Record<string, Minutes>; source: string },
  centerGeo: GeoResult
): Trip {
  const byId = new Map(points.map((p) => [p.id, p]));
  const ordered = optimized.order.map((id) => byId.get(id)).filter((p): p is DeliveryPoint => !!p);

  // 최적화 응답에 빠진 배송지가 있으면 뒤에 붙인다
  for (const p of points) {
    if (!ordered.some((o) => o.id === p.id)) ordered.push(p);
  }

  /**
   * TMAP arriveTime은 주행 시간만 계산한다. 시간창이 열리기 전에 도착하면
   * 기사가 기다렸다 하차하고 이후 배송지가 그만큼 밀린다 — 그 보정을 여기서 한다.
   * 이 처리를 빼면 "일찍 도착"이 위반으로 잡혀 멀쩡한 배송지가 기타로 빠진다.
   */
  const rawArrive: Record<string, Minutes> = {};
  for (const p of ordered) {
    const v = optimized.arriveAt[p.id] ?? planned.sim.arriveAt[p.id];
    if (v !== undefined) rawArrive[p.id] = v;
  }
  const waiting = applyWaiting(
    ordered.map((p) => ({ id: p.id, windows: p.time.windows })),
    rawArrive
  );

  const stops: Stop[] = ordered.map((p, i) => {
    const arriveAt = waiting.arriveAt[p.id] ?? null;
    return {
      seq: i + 1,
      pointId: p.id,
      company: p.parsedName.company + (p.splitIndex ? ` (분할 ${p.splitIndex})` : ""),
      region: p.parsedName.region,
      address: p.address,
      boxes: p.boxes,
      tags: p.tags,
      maxTonnage: p.maxTonnage,
      hasExplicitStart: p.time.hasExplicitStart,
      timeRaw: p.time.columnRaw ?? p.parsedName.conditionText ?? "",
      windows: p.time.windows,
      arriveAt,
      timeOk: arriveAt === null ? null : isWithin(p.time.windows, arriveAt),
      contact: p.contact,
      geo: p.geo,
    };
  });

  const boxes = stops.reduce((s, x) => s + x.boxes, 0);
  const last = ordered[ordered.length - 1];
  const homeKm = last?.geo ? Number(distKm(last.geo, planned.endGeo).toFixed(2)) : 0;

  let driveKm = 0;
  let prev = centerGeo;
  for (const p of ordered) {
    if (p.geo) {
      driveKm += distKm(prev, p.geo);
      prev = p.geo;
    }
  }

  const lastDone = waiting.lastDoneAt;

  return {
    id: `${planned.vehicle.id}-T${planned.tripNo}`,
    vehicleId: planned.vehicle.id,
    기사명: planned.vehicle.기사명,
    톤수라벨: planned.vehicle.톤수라벨,
    tripNo: planned.tripNo,
    stops,
    boxes,
    loadRate: planned.vehicle.최대수량 > 0 ? boxes / planned.vehicle.최대수량 : 0,
    driveKm: Number(driveKm.toFixed(2)),
    homeKm,
    departAt: planned.departAt,
    homeAt: lastDone === null ? null : lastDone + Math.round((homeKm / 42) * 60),
    distanceSource: optimized.source === "tmap" ? "tmap" : "haversine",
  };
}
