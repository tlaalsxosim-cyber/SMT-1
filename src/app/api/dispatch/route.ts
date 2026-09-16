/**
 * POST /api/dispatch — 배차 실행 (FR-24 ~ FR-35, FR-40 ~ FR-44)
 *
 * 실행 잠금(FR-33)과 API 예산(FR-32)을 서버에서 강제한다.
 * 클라이언트의 버튼 비활성화만 믿으면 새로고침 연타로 한도가 날아간다.
 */

import { NextResponse } from "next/server";

import type { DispatchRequestOptions, DispatchResponse } from "@/lib/api/contracts";
import { DEFAULT_DEPART_MINUTES, type EarlyDeliveryMode } from "@/lib/domain/constants";
import { parseFleet } from "@/lib/parse/fleet";
import { parseShipment } from "@/lib/parse/shipment";
import { runPipeline } from "@/lib/pipeline/run";
import { acquireLock, DispatchBusyError, releaseLock } from "@/lib/tmap/counter";
import { TmapError } from "@/lib/tmap/client";
import { buildStatus } from "../status/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 55납품처·12회전 기준 5분 이내 (NFR-04) */
export const maxDuration = 300;

const EARLY_MODES: EarlyDeliveryMode[] = ["endBy9", "endBy10", "startBy9"];

function readOptions(form: FormData): DispatchRequestOptions {
  const raw = form.get("options");
  const parsed: Partial<DispatchRequestOptions> =
    typeof raw === "string" ? safeJson(raw) : {};

  const departAt = Number(parsed.departAt);
  const earlyMode = parsed.earlyMode;

  return {
    demo: parsed.demo !== false,
    useAi: parsed.useAi === true,
    departAt:
      Number.isFinite(departAt) && departAt >= 0 && departAt < 24 * 60
        ? Math.round(departAt)
        : DEFAULT_DEPART_MINUTES,
    earlyMode: earlyMode && EARLY_MODES.includes(earlyMode) ? earlyMode : "endBy10",
    centerAddress:
      typeof parsed.centerAddress === "string" && parsed.centerAddress.trim()
        ? parsed.centerAddress.trim()
        : undefined,
    drawRoutes: parsed.drawRoutes !== false,
  };
}

function safeJson(s: string): Record<string, never> {
  try {
    return JSON.parse(s);
  } catch {
    return {} as Record<string, never>;
  }
}

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "업로드 형식을 읽지 못했습니다" }, { status: 400 });
  }

  const shipmentFile = form.get("shipment");
  const fleetFile = form.get("fleet");

  if (!(shipmentFile instanceof File) || !(fleetFile instanceof File)) {
    return NextResponse.json(
      { error: "출고등록현황과 차량 톤수 파일을 모두 올려야 합니다" },
      { status: 400 }
    );
  }

  const options = readOptions(form);

  // FR-33 — 실행 중 잠금. 버튼 연타를 서버에서 막는다.
  try {
    acquireLock();
  } catch (e) {
    if (e instanceof DispatchBusyError) {
      return NextResponse.json(
        { error: e.message, hint: "경유지 최적화 무료 한도를 지키기 위한 보호 장치입니다" },
        { status: 409 }
      );
    }
    throw e;
  }

  const startedAt = Date.now();

  try {
    const [shipBuf, fleetBuf] = await Promise.all([
      shipmentFile.arrayBuffer(),
      fleetFile.arrayBuffer(),
    ]);

    const ship = await parseShipment(shipBuf);
    const fleet = await parseFleet(fleetBuf);

    const out = await runPipeline(ship, fleet, {
      demo: options.demo,
      useAi: options.useAi,
      departAt: options.departAt,
      earlyMode: options.earlyMode,
      centerAddress: options.centerAddress,
      drawRoutes: options.drawRoutes,
    });

    const response: DispatchResponse = {
      ...out,
      sourceSummary: {
        totalRows: ship.totalRows,
        targetRows: ship.targetRows,
        excludedRows: ship.excluded.length,
        pointCount: ship.points.length,
        totalTrips: fleet.capacity.totalTrips,
        maxBoxes: fleet.capacity.maxBoxes,
        minBoxes: fleet.capacity.minBoxes,
        maxCompanies: fleet.capacity.maxCompanies,
      },
      serverStatus: buildStatus(),
      elapsedMs: Date.now() - startedAt,
    };

    return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof TmapError) {
      return NextResponse.json(
        { error: e.message, hint: e.hint, detail: `HTTP ${e.status}` },
        { status: e.status === 401 ? 401 : 502 }
      );
    }
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: "배차 실행에 실패했습니다", detail: message },
      { status: 500 }
    );
  } finally {
    releaseLock();
  }
}
