/**
 * 차량 톤수.xlsx 파서 (FR-03, FR-07 / PRD §5.2)
 *
 * 8개 컬럼 전부 필수. 하나라도 누락되거나 수치 범위가 어긋나면 업로드를 거부한다.
 * 도착지는 §5.2.1의 품질 이슈(시·군청 대표 주소, 중복, 행정구역 오타)를 그대로
 * 수용하되 경고로 드러낸다.
 */

import type { FleetCapacity, FleetParseResult, Issue, Vehicle } from "@/lib/domain/types";
import { cleanAddress } from "@/lib/structure/delivery-name";
import { num, readSheet, readWorkbook, str, tonnageOf, type SheetTable } from "./workbook";

export const FLEET_COLUMNS = [
  "기사명",
  "톤수",
  "최소수량",
  "최대수량",
  "회전수",
  "최소업체수",
  "최대업체수",
  "도착지",
] as const;

/** 존재하지 않는 행정구역 표기 탐지 — `화성시 만세구` 같은 오타 (§5.2.1) */
const VALID_GU_HINT = /(구|군|읍|면|동|리|로|길)/;

export async function parseFleet(data: ArrayBuffer | Buffer): Promise<FleetParseResult> {
  const wb = await readWorkbook(data);
  const table = readSheet(wb);
  return buildFleetResult(table);
}

export function buildFleetResult(table: SheetTable): FleetParseResult {
  const issues: Issue[] = [];

  const missing = FLEET_COLUMNS.filter((c) => !table.headers.includes(c));
  if (missing.length) {
    throw new Error(
      `차량 마스터 필수 컬럼이 없습니다: ${missing.join(", ")}\n` +
        `발견된 컬럼: ${table.headers.join(", ")}`
    );
  }

  const vehicles: Vehicle[] = [];
  const fatal: string[] = [];

  table.rows.forEach((rec, i) => {
    const rowNo = table.rowNos[i];
    const 기사명 = str(rec["기사명"]);
    if (!기사명) return;

    const 톤수라벨 = str(rec["톤수"]) ?? "";
    const tonnage = tonnageOf(톤수라벨);
    const 최소수량 = num(rec["최소수량"]);
    const 최대수량 = num(rec["최대수량"]);
    const 회전수 = num(rec["회전수"]);
    const 최소업체수 = num(rec["최소업체수"]);
    const 최대업체수 = num(rec["최대업체수"]);
    const 도착지 = str(rec["도착지"]) ?? "";

    const label = `${rowNo}행 ${기사명}`;

    // ── 수치 범위 검증 (FR-03)
    if (최소수량 === null || 최대수량 === null || 회전수 === null || 최소업체수 === null || 최대업체수 === null) {
      fatal.push(`${label}: 수치 컬럼에 빈 값이 있습니다`);
      return;
    }
    if (최소수량 > 최대수량) {
      fatal.push(`${label}: 최소수량(${최소수량}) > 최대수량(${최대수량})`);
      return;
    }
    if (회전수 < 1 || !Number.isInteger(회전수)) {
      fatal.push(`${label}: 회전수는 1 이상의 정수여야 합니다 (현재 ${회전수})`);
      return;
    }
    if (최소업체수 > 최대업체수) {
      fatal.push(`${label}: 최소업체수(${최소업체수}) > 최대업체수(${최대업체수})`);
      return;
    }
    if (최소업체수 < 1) {
      fatal.push(`${label}: 최소업체수는 1 이상이어야 합니다`);
      return;
    }
    if (tonnage === null) {
      issues.push({
        level: "warning",
        code: "FR-03",
        message: "톤수 라벨에서 숫자를 읽지 못했습니다 — 차량 톤수 제한 규칙(R-10)이 적용되지 않습니다",
        subject: 기사명,
        detail: 톤수라벨,
      });
    }
    if (!도착지) {
      issues.push({
        level: "error",
        code: "FR-03",
        message: "도착지가 비어 있습니다 — 귀가 동선을 계산할 수 없습니다",
        subject: 기사명,
      });
    } else if (!VALID_GU_HINT.test(도착지)) {
      issues.push({
        level: "warning",
        code: "FR-03",
        message: "도착지 주소 형식이 비정상으로 보입니다",
        subject: 기사명,
        detail: 도착지,
      });
    }

    vehicles.push({
      id: `V${String(vehicles.length + 1).padStart(2, "0")}`,
      기사명,
      톤수라벨,
      tonnage: tonnage ?? 0,
      최소수량,
      최대수량,
      회전수,
      최소업체수,
      최대업체수,
      도착지,
      cleanArrival: cleanAddress(도착지),
    });
  });

  if (fatal.length) {
    throw new Error(`차량 마스터 검증 실패\n${fatal.map((f) => `· ${f}`).join("\n")}`);
  }
  if (vehicles.length === 0) {
    throw new Error("차량 마스터에 유효한 기사 행이 없습니다");
  }

  // ── 도착지 중복 경고 (§5.2.1)
  const byArrival = new Map<string, string[]>();
  for (const v of vehicles) {
    const key = v.도착지.replace(/\s+/g, "");
    byArrival.set(key, [...(byArrival.get(key) ?? []), v.기사명]);
  }
  for (const [addr, names] of byArrival) {
    if (names.length > 1) {
      issues.push({
        level: "warning",
        code: "OI-4",
        message: `도착지가 동일한 기사가 ${names.length}명입니다 — 귀가 거리 비교가 무의미해집니다`,
        subject: names.join(", "),
        detail: addr,
      });
    }
  }

  const capacity = computeCapacity(vehicles);

  return { vehicles, capacity, issues };
}

/** 업로드 즉시 표시하는 파생 지표 (FR-07 / PRD §5.2 파생 지표) */
export function computeCapacity(vehicles: Vehicle[]): FleetCapacity {
  return vehicles.reduce<FleetCapacity>(
    (acc, v) => ({
      driverCount: acc.driverCount + 1,
      totalTrips: acc.totalTrips + v.회전수,
      maxBoxes: acc.maxBoxes + v.최대수량 * v.회전수,
      minBoxes: acc.minBoxes + v.최소수량 * v.회전수,
      maxCompanies: acc.maxCompanies + v.최대업체수 * v.회전수,
      minCompanies: acc.minCompanies + v.최소업체수 * v.회전수,
    }),
    { driverCount: 0, totalTrips: 0, maxBoxes: 0, minBoxes: 0, maxCompanies: 0, minCompanies: 0 }
  );
}
