/**
 * POST /api/parse — 업로드 미리보기 (FR-01 ~ FR-08)
 *
 * 두 파일을 함께 받아 파싱·검증하고, 원문과 해석을 나란히 보여줄 데이터를 만든다.
 * 이 단계에서는 TMAP도 AI도 부르지 않는다 — 담당자가 확인하기 전에 비용을 쓰지 않는다.
 */

import { NextResponse } from "next/server";

import type { ParseResponse, PreviewPoint, PreviewVehicle } from "@/lib/api/contracts";
import { EARLY_DELIVERY_MODE_DEFAULT } from "@/lib/domain/constants";
import { isEarlyDelivery } from "@/lib/dispatch/assign";
import { parseFleet } from "@/lib/parse/fleet";
import { parseShipment } from "@/lib/parse/shipment";
import { formatWindows } from "@/lib/structure/time-window";
import { buildStatus } from "../status/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 업로드 파일이 커질 수 있어 응답 스트리밍 제한을 넉넉히 둔다 */
export const maxDuration = 60;

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "업로드 형식을 읽지 못했습니다", hint: "파일 2개를 함께 올려 주십시오" },
      { status: 400 }
    );
  }

  const shipmentFile = form.get("shipment");
  const fleetFile = form.get("fleet");

  // FR-01 — 한 개만 올리면 실행 불가
  if (!(shipmentFile instanceof File) || !(fleetFile instanceof File)) {
    return NextResponse.json(
      {
        error: "출고등록현황과 차량 톤수 파일을 모두 올려야 합니다",
        hint: "두 파일은 항상 함께 업로드합니다 (무저장 구조 — 매회 전체 입력)",
      },
      { status: 400 }
    );
  }

  try {
    const [shipBuf, fleetBuf] = await Promise.all([
      shipmentFile.arrayBuffer(),
      fleetFile.arrayBuffer(),
    ]);

    const ship = await parseShipment(shipBuf);
    const fleet = await parseFleet(fleetBuf);

    // ── 제외 사유별 집계
    const excludedMap = new Map<string, { rows: number; boxes: number }>();
    for (const e of ship.excluded) {
      const cur = excludedMap.get(e.reason) ?? { rows: 0, boxes: 0 };
      excludedMap.set(e.reason, { rows: cur.rows + 1, boxes: cur.boxes + e.boxes });
    }

    const points: PreviewPoint[] = ship.points.map((p) => ({
      id: p.id,
      company: p.parsedName.company,
      region: p.parsedName.region,
      courseCode: p.parsedName.courseCode,
      address: p.address,
      cleanAddress: p.cleanAddress,
      boxes: p.boxes,
      columnRaw: p.time.columnRaw,
      conditionText: p.parsedName.conditionText,
      windows: p.time.windows,
      windowsText: formatWindows(p.time.windows),
      mismatch: p.time.mismatch,
      note: p.time.note,
      tags: p.tags,
      maxTonnage: p.maxTonnage,
      memoBoxes: p.memoBoxes,
      orderRows: p.rowNos.length,
    }));

    const vehicles: PreviewVehicle[] = fleet.vehicles.map((v) => ({
      ...v,
      capacityText: `${v.최소수량}~${v.최대수량}박스 · ${v.최소업체수}~${v.최대업체수}개사 · ${v.회전수}회전`,
    }));

    const earlyCandidates = ship.points
      .filter((p) => isEarlyDelivery(p, EARLY_DELIVERY_MODE_DEFAULT))
      .map((p) => ({
        company: p.parsedName.company,
        windowsText: formatWindows(p.time.windows),
      }));

    const response: ParseResponse = {
      date: ship.date,
      totalRows: ship.totalRows,
      targetRows: ship.targetRows,
      excluded: [...excludedMap.entries()].map(([reason, v]) => ({ reason, ...v })),
      excludedRows: ship.excluded.length,
      pointCount: ship.points.length,
      totalBoxes: ship.totalBoxes,
      points,
      vehicles,
      capacity: fleet.capacity,
      issues: [...ship.issues, ...fleet.issues],
      warnings: {
        structuralShortfall: ship.points.length - fleet.capacity.maxCompanies,
        capacityShortfall: ship.totalBoxes - fleet.capacity.maxBoxes,
        belowMinimum: ship.totalBoxes < fleet.capacity.minBoxes,
      },
      earlyCandidates,
      serverStatus: buildStatus(),
    };

    return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        error: "파일 검증에 실패했습니다",
        detail: message,
        hint: "컬럼 구성과 수치 범위를 확인한 뒤 파일을 고쳐 다시 업로드하십시오",
      },
      { status: 422 }
    );
  }
}
