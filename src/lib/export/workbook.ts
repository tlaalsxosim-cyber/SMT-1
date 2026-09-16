/**
 * 결과 엑셀 생성 (FR-50 ~ FR-53 / PRD §10)
 *
 * 화면은 검토용이고, **보관·공유·수정의 기준 문서는 이 엑셀**이다.
 * 무저장 구조에서 이 파일이 유일한 산출물이므로, 담당자가 이것만 보고
 * 배차·용차·주소 수정을 모두 판단할 수 있어야 한다.
 */

import ExcelJS from "exceljs";

import { API_LIMITS } from "@/lib/domain/constants";
import type { DispatchResult, Issue, Vehicle } from "@/lib/domain/types";
import { formatWindows, toHHMM } from "@/lib/structure/time-window";

export interface ExportInput extends DispatchResult {
  vehicles: Vehicle[];
  /** 좌표 시트 포함 여부 — 기본 비활성 (FR-53 / OI-5) */
  includeCoordinates?: boolean;
  /** 업로드 단계 지표 */
  sourceSummary?: {
    totalRows: number;
    targetRows: number;
    excludedRows: number;
    pointCount: number;
    totalTrips: number;
    maxBoxes: number;
    minBoxes: number;
    maxCompanies: number;
  };
}

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1E293B" },
};

const WARN_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFFEF3C7" },
};

const ERROR_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFFEE2E2" },
};

function styleHeader(row: ExcelJS.Row): void {
  row.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = { bottom: { style: "thin", color: { argb: "FF334155" } } };
  });
  row.height = 26;
}

function setColumns(ws: ExcelJS.Worksheet, defs: { header: string; key: string; width: number }[]) {
  ws.columns = defs.map((d) => ({ header: d.header, key: d.key, width: d.width }));
  styleHeader(ws.getRow(1));
  ws.views = [{ state: "frozen", ySplit: 1 }];
}

function hhmm(m: number | null | undefined): string {
  return m === null || m === undefined ? "" : toHHMM(m);
}

function formatDate(yyyymmdd: string): string {
  if (!/^\d{8}$/.test(yyyymmdd)) return yyyymmdd;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

export async function buildResultWorkbook(input: ExportInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "AI 기반 일일 배송 최적화 시스템";
  wb.created = new Date();

  buildDispatchSheet(wb, input);
  buildUnassignedSheet(wb, input);
  buildAddressSheet(wb, input);
  buildSummarySheet(wb, input);
  buildIssueSheet(wb, input);
  if (input.includeCoordinates) buildCoordinateSheet(wb, input);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// ─────────────────────────────────────────────────────────────
// 시트 1: 배차표
// ─────────────────────────────────────────────────────────────

function buildDispatchSheet(wb: ExcelJS.Workbook, input: ExportInput): void {
  const ws = wb.addWorksheet("배차표", {
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  setColumns(ws, [
    { header: "기사명", key: "driver", width: 14 },
    { header: "톤수", key: "tonnage", width: 8 },
    { header: "회전", key: "trip", width: 6 },
    { header: "방문\n순서", key: "seq", width: 6 },
    { header: "업체명", key: "company", width: 26 },
    { header: "권역", key: "region", width: 16 },
    { header: "주소", key: "address", width: 46 },
    { header: "박스\n수량", key: "boxes", width: 8 },
    { header: "납품시간\n(원문)", key: "timeRaw", width: 22 },
    { header: "납품시간\n(해석)", key: "windows", width: 26 },
    { header: "TMAP\n도착예정", key: "arrive", width: 11 },
    { header: "시간창\n충족", key: "timeOk", width: 9 },
    { header: "특이사항 태그", key: "tags", width: 30 },
    { header: "연락처", key: "contact", width: 16 },
  ]);

  const byDriver = [...input.trips].sort(
    (a, b) => a.기사명.localeCompare(b.기사명, "ko") || a.tripNo - b.tripNo
  );

  for (const trip of byDriver) {
    const v = input.vehicles.find((x) => x.id === trip.vehicleId);

    for (const stop of trip.stops) {
      const row = ws.addRow({
        driver: trip.기사명,
        tonnage: trip.톤수라벨,
        trip: `${trip.tripNo}회전`,
        seq: stop.seq,
        company: stop.company,
        region: stop.region,
        address: stop.address,
        boxes: stop.boxes,
        timeRaw: stop.timeRaw || "-",
        windows: formatWindows(stop.windows),
        arrive: hhmm(stop.arriveAt),
        timeOk: stop.timeOk === null ? "-" : stop.timeOk ? "OK" : "위반",
        tags: stop.tags.join(", "),
        contact: stop.contact ?? "",
      });
      row.alignment = { vertical: "middle" };
      if (stop.timeOk === false) {
        row.eachCell((c) => (c.fill = ERROR_FILL));
      }
    }

    // 회전 소계 — 적재율·주행거리·귀가거리 (§10 시트1)
    const subtotal = ws.addRow({
      driver: `${trip.기사명} ${trip.tripNo}회전 소계`,
      tonnage: "",
      trip: "",
      seq: "",
      company: `${trip.stops.length}개사`,
      region: "",
      address: `출발 ${hhmm(trip.departAt)} · 귀가 도착 ${hhmm(trip.homeAt)} · 거리 근거 ${
        trip.distanceSource === "tmap" ? "TMAP 실도로" : "직선거리 근사"
      }`,
      boxes: trip.boxes,
      timeRaw: v ? `적재범위 ${v.최소수량}~${v.최대수량}` : "",
      windows: `적재율 ${(trip.loadRate * 100).toFixed(0)}%`,
      arrive: "",
      timeOk: "",
      tags: `주행 ${trip.driveKm.toFixed(1)}km`,
      contact: `귀가 ${trip.homeKm.toFixed(1)}km`,
    });
    subtotal.font = { bold: true };
    subtotal.eachCell((c) => {
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F5F9" } };
      c.border = { top: { style: "thin", color: { argb: "FFCBD5E1" } } };
    });
    ws.addRow({});
  }

  if (byDriver.length === 0) ws.addRow({ driver: "배차된 회전이 없습니다" });
  ws.autoFilter = { from: "A1", to: "N1" };
}

// ─────────────────────────────────────────────────────────────
// 시트 2: 기타_미배차
// ─────────────────────────────────────────────────────────────

function buildUnassignedSheet(wb: ExcelJS.Workbook, input: ExportInput): void {
  const ws = wb.addWorksheet("기타_미배차");

  setColumns(ws, [
    { header: "권역", key: "region", width: 18 },
    { header: "업체명", key: "company", width: 28 },
    { header: "주소", key: "address", width: 48 },
    { header: "박스수량", key: "boxes", width: 10 },
    { header: "납품시간", key: "time", width: 24 },
    { header: "사유코드", key: "reason", width: 14 },
    { header: "비고", key: "note", width: 60 },
  ]);

  // 권역별로 묶어 용차 1대로 담을 수 있는지 보이게 한다 (R-12 / G4)
  const byRegion = new Map<string, typeof input.unassigned>();
  for (const u of input.unassigned) {
    const key = u.region || "미상";
    byRegion.set(key, [...(byRegion.get(key) ?? []), u]);
  }

  const regions = [...byRegion.entries()].sort(
    (a, b) =>
      b[1].reduce((s, x) => s + x.boxes, 0) - a[1].reduce((s, x) => s + x.boxes, 0)
  );

  for (const [region, items] of regions) {
    for (const u of items.sort((a, b) => b.boxes - a.boxes)) {
      ws.addRow({
        region,
        company: u.company,
        address: u.address,
        boxes: u.boxes,
        time: u.timeRaw || "-",
        reason: u.reason,
        note: u.note,
      });
    }
    const sub = ws.addRow({
      region: `${region} 소계`,
      company: `${items.length}개사`,
      address: "",
      boxes: items.reduce((s, x) => s + x.boxes, 0),
      time: "",
      reason: "",
      note: "용차 1대로 묶을 수 있는지 검토",
    });
    sub.font = { bold: true };
    sub.eachCell((c) => (c.fill = WARN_FILL));
  }

  const total = ws.addRow({
    region: "합계",
    company: `${input.unassigned.length}건`,
    address: "",
    boxes: input.unassignedBoxes,
    time: "",
    reason: "",
    note: `총 물량 ${input.totalBoxes.toLocaleString()}박스 중 ${(
      (input.unassignedBoxes / Math.max(1, input.totalBoxes)) * 100
    ).toFixed(1)}%`,
  });
  total.font = { bold: true, size: 11 };

  if (input.unassigned.length === 0) ws.addRow({ region: "미배차 물량이 없습니다" });
}

// ─────────────────────────────────────────────────────────────
// 시트 3: 주소확인필요
// ─────────────────────────────────────────────────────────────

function buildAddressSheet(wb: ExcelJS.Workbook, input: ExportInput): void {
  const ws = wb.addWorksheet("주소확인필요");

  setColumns(ws, [
    { header: "업체명", key: "company", width: 28 },
    { header: "원문 주소", key: "raw", width: 52 },
    { header: "조회에 사용한 주소", key: "queried", width: 52 },
    { header: "실패 유형", key: "type", width: 14 },
    { header: "AI 정제 제안", key: "suggestion", width: 52 },
    { header: "비고", key: "note", width: 48 },
  ]);

  for (const a of input.addressIssues) {
    const row = ws.addRow({
      company: a.company,
      raw: a.rawAddress,
      queried: a.queriedAddress,
      type: a.failureType,
      suggestion: a.suggestion ?? "(제안 없음)",
      note: a.note,
    });
    if (a.failureType === "변환실패" || a.failureType === "도착지실패") {
      row.eachCell((c) => (c.fill = ERROR_FILL));
    } else {
      row.eachCell((c) => (c.fill = WARN_FILL));
    }
  }

  if (input.addressIssues.length === 0) {
    ws.addRow({ company: "주소 확인이 필요한 건이 없습니다" });
  } else {
    ws.addRow({});
    ws.addRow({
      company: "안내",
      raw: "AI 제안은 참고용입니다. 원본 출고등록현황.xlsx의 주소를 고쳐 다시 업로드해야 좌표가 확정됩니다.",
    }).font = { italic: true };
  }
}

// ─────────────────────────────────────────────────────────────
// 시트 4: 요약
// ─────────────────────────────────────────────────────────────

function buildSummarySheet(wb: ExcelJS.Workbook, input: ExportInput): void {
  const ws = wb.addWorksheet("요약");
  ws.columns = [
    { key: "label", width: 30 },
    { key: "value", width: 30 },
    { key: "note", width: 70 },
  ];

  const section = (title: string) => {
    const r = ws.addRow({ label: title });
    r.font = { bold: true, size: 12, color: { argb: "FFFFFFFF" } };
    r.eachCell((c) => (c.fill = HEADER_FILL));
    r.height = 22;
  };
  const line = (label: string, value: string | number, note = "") =>
    ws.addRow({ label, value, note });

  section("실행 정보");
  line("출고일자", formatDate(input.date));
  line("생성 시각", new Date(input.generatedAt).toLocaleString("ko-KR"));
  line("실행 모드", input.demoMode ? "Demo Mode (TMAP 미호출)" : "운영 (TMAP 호출)");
  line("적용 규칙 버전", "PRD v1.0 / R-01~R-18");
  ws.addRow({});

  if (input.sourceSummary) {
    const s = input.sourceSummary;
    section("입력 데이터");
    line("총 오더 행", s.totalRows);
    line("배차 대상 행", s.targetRows, "배송방법 빈값만 (픽업·이체·취소 제외)");
    line("제외 행", s.excludedRows);
    line("납품처 수", s.pointCount);
    line("총 물량", `${input.totalBoxes.toLocaleString()} 박스`);
    ws.addRow({});

    section("차량 가용 능력");
    line("총 회전", s.totalTrips);
    line("적재 상한", `${s.maxBoxes.toLocaleString()} 박스`);
    line("적재 하한", `${s.minBoxes.toLocaleString()} 박스`, "최소수량 미달 차량은 출고하지 않음 (R-04)");
    line("업체 수 상한", s.maxCompanies, `납품처 ${s.pointCount}곳 대비 ${s.pointCount > s.maxCompanies ? `최소 ${s.pointCount - s.maxCompanies}곳 구조적 미배차` : "여유"}`);
    ws.addRow({});
  }

  section("배차 결과");
  line("사용 회전", input.usedTrips);
  line("배차 물량", `${input.assignedBoxes.toLocaleString()} 박스`, `${((input.assignedBoxes / Math.max(1, input.totalBoxes)) * 100).toFixed(1)}%`);
  line("기타 물량", `${input.unassignedBoxes.toLocaleString()} 박스`, `${input.unassigned.length}건 — 용차 판단 대상`);
  line("총 주행거리", `${input.trips.reduce((s, t) => s + t.driveKm, 0).toFixed(1)} km`);
  line("공차 귀가거리", `${input.trips.reduce((s, t) => s + t.homeKm, 0).toFixed(1)} km`, "마지막 하차지 → 기사 도착지");
  const rates = input.trips.filter((t) => t.stops.length).map((t) => t.loadRate);
  line(
    "평균 적재율",
    rates.length ? `${((rates.reduce((s, r) => s + r, 0) / rates.length) * 100).toFixed(0)}%` : "-"
  );
  ws.addRow({});

  section("제약 검증");
  const violationRow = line(
    "제약 위반 건수",
    input.violations.length,
    input.violations.length === 0 ? "적재·업체수·시간창·톤수 제약 모두 충족" : "아래 위반 내역 확인"
  );
  if (input.violations.length > 0) violationRow.eachCell((c) => (c.fill = ERROR_FILL));

  const timeWarnings = input.trips.flatMap((t) => t.stops).filter((s) => s.timeOk === false).length;
  line("시간창 경고", timeWarnings, timeWarnings === 0 ? "TMAP 도착예정시각이 모두 시간창 안" : "");
  for (const v of input.violations) {
    line(`  [${v.code}]`, v.subject ?? "", v.message).eachCell((c) => (c.fill = ERROR_FILL));
  }
  ws.addRow({});

  section("API 호출 건수");
  const u = input.apiUsage;
  line("지오코딩", u.geocode, `무료 한도 ${API_LIMITS.geocode.toLocaleString()}`);
  line("자동차 경로안내", u.routes, `무료 한도 ${API_LIMITS.routes.toLocaleString()}`);
  line("다중 경유지", u.sequential, "경로안내 한도 공유");
  const optRow = line("경유지 최적화", u.optimize, `무료 한도 ${API_LIMITS.optimize} — 가장 귀한 자원`);
  if (u.optimize > API_LIMITS.optimize * 0.5) optRow.eachCell((c) => (c.fill = WARN_FILL));
  ws.addRow({});

  if (input.briefing) {
    section("AI 브리핑");
    for (const l of input.briefing.split("\n")) {
      const r = ws.addRow({ label: "", value: "", note: l });
      r.getCell("note").alignment = { wrapText: true, vertical: "top" };
    }
    ws.addRow({});
  }

  section("무저장 구조 안내");
  const notice = ws.addRow({
    label: "",
    value: "",
    note:
      "이 파일이 유일한 산출물입니다. 서버·브라우저에 데이터가 남지 않으며, " +
      "TMAP 경로 좌표도 보관하지 않습니다. 보관·공유·수정은 이 엑셀을 기준으로 하십시오.",
  });
  notice.getCell("note").alignment = { wrapText: true, vertical: "top" };
  notice.height = 34;
}

// ─────────────────────────────────────────────────────────────
// 시트 5: 검증이슈 (담당자 확인 목록)
// ─────────────────────────────────────────────────────────────

function buildIssueSheet(wb: ExcelJS.Workbook, input: ExportInput): void {
  const ws = wb.addWorksheet("검증이슈");

  setColumns(ws, [
    { header: "수준", key: "level", width: 10 },
    { header: "코드", key: "code", width: 10 },
    { header: "대상", key: "subject", width: 28 },
    { header: "내용", key: "message", width: 56 },
    { header: "상세", key: "detail", width: 80 },
  ]);

  const order: Record<Issue["level"], number> = { error: 0, warning: 1, info: 2 };
  const sorted = [...input.issues].sort(
    (a, b) => order[a.level] - order[b.level] || a.code.localeCompare(b.code)
  );

  for (const i of sorted) {
    const row = ws.addRow({
      level: i.level === "error" ? "오류" : i.level === "warning" ? "경고" : "정보",
      code: i.code,
      subject: i.subject ?? "",
      message: i.message,
      detail: i.detail ?? "",
    });
    row.getCell("detail").alignment = { wrapText: true, vertical: "top" };
    if (i.level === "error") row.eachCell((c) => (c.fill = ERROR_FILL));
    else if (i.level === "warning") row.eachCell((c) => (c.fill = WARN_FILL));
  }

  if (sorted.length === 0) ws.addRow({ level: "정보", message: "검증 이슈가 없습니다" });
}

// ─────────────────────────────────────────────────────────────
// 시트 6: 좌표 (선택 · 기본 비활성 — FR-53 / OI-5)
// ─────────────────────────────────────────────────────────────

function buildCoordinateSheet(wb: ExcelJS.Workbook, input: ExportInput): void {
  const ws = wb.addWorksheet("좌표");

  setColumns(ws, [
    { header: "구분", key: "kind", width: 12 },
    { header: "업체명/기사명", key: "name", width: 28 },
    { header: "주소", key: "address", width: 52 },
    { header: "위도", key: "lat", width: 14 },
    { header: "경도", key: "lon", width: 14 },
    { header: "좌표 출처", key: "source", width: 12 },
  ]);

  const warn = ws.addRow({
    kind: "주의",
    name: "TMAP 약관 확인 필요",
    address:
      "경로 응답 좌표는 24시간 이상 저장·재사용이 금지됩니다. 이 시트의 재사용 가능 범위를 운영 전 확인하십시오 (OI-5).",
  });
  warn.eachCell((c) => (c.fill = WARN_FILL));
  warn.font = { bold: true };

  for (const t of input.trips) {
    for (const s of t.stops) {
      if (!s.geo) continue;
      ws.addRow({
        kind: "납품처",
        name: s.company,
        address: s.address,
        lat: s.geo.lat,
        lon: s.geo.lon,
        source: s.geo.source,
      });
    }
  }

  for (const v of input.vehicles) {
    if (!v.arrivalGeo) continue;
    ws.addRow({
      kind: "기사 도착지",
      name: v.기사명,
      address: v.도착지,
      lat: v.arrivalGeo.lat,
      lon: v.arrivalGeo.lon,
      source: v.arrivalGeo.source,
    });
  }
}

/** 다운로드 파일명 (FR-52) */
export function resultFileName(date: string): string {
  const now = new Date();
  const stamp =
    `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  return `배차결과_${date}_${stamp}.xlsx`;
}
