/**
 * POST /api/export — 결과 엑셀 생성 (FR-50 ~ FR-53)
 *
 * 클라이언트가 들고 있던 배차 결과를 그대로 받아 엑셀로 만들어 돌려준다.
 * 서버는 아무것도 보관하지 않는다 (NFR-01).
 */

import { NextResponse } from "next/server";

import type { DispatchResponse } from "@/lib/api/contracts";
import { buildResultWorkbook, resultFileName } from "@/lib/export/workbook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface ExportBody {
  result?: DispatchResponse;
  includeCoordinates?: boolean;
}

export async function POST(req: Request) {
  let body: ExportBody;
  try {
    body = (await req.json()) as ExportBody;
  } catch {
    return NextResponse.json({ error: "요청 본문을 읽지 못했습니다" }, { status: 400 });
  }

  const result = body.result;
  if (!result || !Array.isArray(result.trips)) {
    return NextResponse.json(
      { error: "배차 결과가 없습니다", hint: "배차를 먼저 실행하십시오" },
      { status: 400 }
    );
  }

  try {
    const buffer = await buildResultWorkbook({
      ...result,
      includeCoordinates: body.includeCoordinates === true,
      sourceSummary: result.sourceSummary,
    });

    const filename = resultFileName(result.date || "결과");

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        // 한글 파일명은 RFC 5987 형식으로 보낸다
        "Content-Disposition": `attachment; filename="dispatch-result.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Content-Length": String(buffer.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: "엑셀 생성에 실패했습니다", detail: message },
      { status: 500 }
    );
  }
}
