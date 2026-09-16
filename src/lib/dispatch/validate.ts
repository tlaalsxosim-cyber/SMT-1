/**
 * 배차 결과 제약 검증 (FR-41 / AC-11)
 *
 * 배차 로직이 제약을 지켰다고 주장하는 것과, 결과물이 실제로 제약을 지키는지는 다른 문제다.
 * 이 모듈은 완성된 배차 결과를 **처음 보는 것처럼** 다시 검사한다.
 * 여기서 나온 위반 건수가 결과 엑셀 요약 시트의 "제약 위반 건수"다.
 */

import {
  EARLY_DELIVERY_RULES,
  SECOND_TRIP_MIN_DEADLINE,
  type EarlyDeliveryMode,
} from "@/lib/domain/constants";
import type { DispatchResult, Issue, Trip, Vehicle } from "@/lib/domain/types";
import { METRO_SOUTH_LIMIT_LAT } from "@/lib/domain/constants";
import { isLargeVehicle } from "@/lib/dispatch/assign";
import { siteKey } from "@/lib/structure/delivery-name";
import { formatWindows, isWithin, latestDeadline, toHHMM } from "@/lib/structure/time-window";

export interface ValidateInput {
  trips: Trip[];
  vehicles: Vehicle[];
  earlyMode: EarlyDeliveryMode;
  /** 2회전 이상 회전의 마감 하한 (R-15). 기본 15:00 */
  secondTripMinDeadline?: number;
  /** 입력 총 박스 — 배차 + 기타 합계와 대조한다 */
  totalBoxes: number;
  assignedBoxes: number;
  unassignedBoxes: number;
}

export function validateDispatch(input: ValidateInput): Issue[] {
  const violations: Issue[] = [];
  const byId = new Map(input.vehicles.map((v) => [v.id, v]));
  const earlyRule = EARLY_DELIVERY_RULES[input.earlyMode];
  const deadlineFloor = input.secondTripMinDeadline ?? SECOND_TRIP_MIN_DEADLINE;

  const earlyByDriver = new Map<string, string[]>();
  const seenPoints = new Set<string>();

  for (const trip of input.trips) {
    const v = byId.get(trip.vehicleId);
    const label = `${trip.기사명} ${trip.tripNo}회전`;

    if (!v) {
      violations.push({
        level: "error",
        code: "FR-41",
        message: "배차표에 차량 마스터에 없는 기사가 있습니다",
        subject: label,
      });
      continue;
    }

    // R-03 적재 범위
    if (trip.boxes > v.최대수량) {
      violations.push({
        level: "error",
        code: "R-03",
        message: `적재 상한 초과 — ${trip.boxes} > ${v.최대수량}`,
        subject: label,
      });
    }
    // R-04 최소 미달 차량은 출고하지 않음 — 배차표에 올라온 이상 하한을 지켜야 한다
    if (trip.stops.length > 0 && trip.boxes < v.최소수량) {
      violations.push({
        level: "error",
        code: "R-04",
        message: `적재 하한 미달 — ${trip.boxes} < ${v.최소수량}`,
        subject: label,
      });
    }

    // R-05 업체 수 범위
    if (trip.stops.length > 0) {
      if (trip.stops.length > v.최대업체수) {
        violations.push({
          level: "error",
          code: "R-05",
          message: `업체 수 상한 초과 — ${trip.stops.length} > ${v.최대업체수}`,
          subject: label,
        });
      }
      if (trip.stops.length < v.최소업체수) {
        violations.push({
          level: "error",
          code: "R-05",
          message: `업체 수 하한 미달 — ${trip.stops.length} < ${v.최소업체수}`,
          subject: label,
        });
      }
    }

    /**
     * R-17 — 대형차(5톤 이상)는 회전당 1업체가 원칙이다.
     * 2번째 업체는 주소가 거의 동일할 때만 허용한다.
     */
    if (isLargeVehicle(v) && trip.stops.length > 1) {
      const sites = new Set(trip.stops.map((st) => siteKey(st.address)));
      if (sites.size > 1) {
        violations.push({
          level: "error",
          code: "R-17",
          message: `대형차 1업체 원칙 위반 — 주소가 다른 업체 ${trip.stops.length}곳 배정`,
          subject: label,
          detail: trip.stops.map((st) => `${st.company}(${st.address})`).join(" / "),
        });
      }
    }

    // 박스 합계 정합성
    const sum = trip.stops.reduce((s, x) => s + x.boxes, 0);
    if (sum !== trip.boxes) {
      violations.push({
        level: "error",
        code: "FR-41",
        message: `회전 박스 합계 불일치 — 표기 ${trip.boxes} / 실제 ${sum}`,
        subject: label,
      });
    }

    for (const stop of trip.stops) {
      // 중복 배차
      if (seenPoints.has(stop.pointId)) {
        violations.push({
          level: "error",
          code: "FR-41",
          message: "같은 배송지가 두 번 배차되었습니다",
          subject: `${label} · ${stop.company}`,
        });
      }
      seenPoints.add(stop.pointId);

      /**
       * R-18 — 천안 이남은 지입 배차에서 제외한다. 배차표에 올라왔다면 위반이다.
       * 좌표가 없는 건은 애초에 배차 대상이 아니므로(R-13) 판정하지 않는다.
       */
      if (stop.geo && stop.geo.lat < METRO_SOUTH_LIMIT_LAT) {
        violations.push({
          level: "error",
          code: "R-18",
          message: `수도권 외 배차 — 위도 ${stop.geo.lat.toFixed(3)} < ${METRO_SOUTH_LIMIT_LAT} (천안 이남)`,
          subject: `${label} · ${stop.company}`,
          detail: stop.address,
        });
      }

      // R-10 차량 톤수 제약
      const limit = stop.maxTonnage;
      if (limit !== null && v.tonnage > limit) {
        violations.push({
          level: "error",
          code: "R-10",
          message: `${limit}톤 이하 제약 위반 — ${v.톤수라벨} 배정`,
          subject: `${label} · ${stop.company}`,
        });
      }

      // 시간창 (FR-25) — TMAP arriveTime이 있을 때만 판정한다
      if (stop.arriveAt !== null && stop.windows.length > 0) {
        if (!isWithin(stop.windows, stop.arriveAt)) {
          violations.push({
            level: "error",
            code: "R-11",
            message: `시간창 위반 — 도착 ${toHHMM(stop.arriveAt)} / 허용 ${formatWindows(stop.windows)}`,
            subject: `${label} · ${stop.company}`,
          });
        }
      }

      /**
       * R-15 — 센터 복귀 후 재출발하는 회전(2회전 이상)에는
       * 마감이 하한보다 이른 배송지를 배정할 수 없다.
       */
      if (trip.tripNo > 1) {
        const deadline = latestDeadline(stop.windows);
        if (deadline !== null && deadline < deadlineFloor) {
          violations.push({
            level: "error",
            code: "R-15",
            message: `2회전 마감 하한 위반 — 마감 ${toHHMM(deadline)} < ${toHHMM(deadlineFloor)}`,
            subject: `${label} · ${stop.company}`,
          });
        }
      }

      // R-08 조기납품 — 집계만 하고 판정은 기사 단위로 한다 (회전 번호는 제약이 아니다)
      if (stop.windows.some((w) => earlyRule.test(w, { hasExplicitStart: stop.hasExplicitStart }))) {
        earlyByDriver.set(trip.기사명, [
          ...(earlyByDriver.get(trip.기사명) ?? []),
          `${stop.company}(${trip.tripNo}회전)`,
        ]);
      }
    }
  }

  // R-08 — 한 기사에게 조기납품 업체가 2곳 이상 배정되면 안 된다
  for (const [기사명, list] of earlyByDriver) {
    if (list.length > 1) {
      violations.push({
        level: "error",
        code: "R-08",
        message: `조기납품이 기사당 1곳 제한을 넘었습니다 (${list.length}곳)`,
        subject: 기사명,
        detail: list.join(", "),
      });
    }
  }

  // R-12 전량 소진 — 배차 + 기타 = 총 물량
  const accounted = input.assignedBoxes + input.unassignedBoxes;
  if (accounted !== input.totalBoxes) {
    violations.push({
      level: "error",
      code: "R-12",
      message: `물량 합계 불일치 — 총 ${input.totalBoxes} / 배차 ${input.assignedBoxes} + 기타 ${input.unassignedBoxes} = ${accounted}`,
    });
  }

  return violations;
}

/** 요약 지표 — 화면 상단 카드와 엑셀 요약 시트에 쓴다 */
export function summarize(result: DispatchResult) {
  const loadRates = result.trips.filter((t) => t.stops.length > 0).map((t) => t.loadRate);
  return {
    usedTrips: result.usedTrips,
    assignedBoxes: result.assignedBoxes,
    unassignedBoxes: result.unassignedBoxes,
    avgLoadRate: loadRates.length
      ? loadRates.reduce((s, r) => s + r, 0) / loadRates.length
      : 0,
    totalDriveKm: result.trips.reduce((s, t) => s + t.driveKm, 0),
    totalHomeKm: result.trips.reduce((s, t) => s + t.homeKm, 0),
    violationCount: result.violations.length,
    timeWarnings: result.trips
      .flatMap((t) => t.stops)
      .filter((s) => s.timeOk === false).length,
  };
}
