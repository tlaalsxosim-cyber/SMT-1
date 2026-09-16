/**
 * GET /api/status — 키 상태와 일일 API 호출 카운터 (FR-32 / NFR-03)
 *
 * 키 **값**은 절대 내려보내지 않는다. 존재 여부만 알린다.
 */

import { NextResponse } from "next/server";

import type { ServerStatus } from "@/lib/api/contracts";
import { report } from "@/lib/tmap/counter";

export const dynamic = "force-dynamic";

export function buildStatus(): ServerStatus {
  return {
    tmapKeyPresent: Boolean(process.env.TMAP_APP_KEY),
    anthropicKeyPresent: Boolean(
      process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
    ),
    mapKeyPresent: Boolean(process.env.NEXT_PUBLIC_TMAP_WEB_KEY),
    usage: report(),
  };
}

export async function GET() {
  return NextResponse.json(buildStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}
