/**
 * 출고등록현황.xlsx 파서 (FR-01, FR-02, FR-04~08 / R-01, R-02)
 *
 * 처리 순서
 *   1. 필수 컬럼 존재 검증
 *   2. 배차 대상 필터 — 배송방법 빈값만 (픽업·이체·취소 제외)
 *   3. 납품처 + 주소 단위 박스 합산
 *   4. 납품처명 파싱 · 시간창 대조 병합 · 태그 추출
 *   5. 교차 검증 — 비고(건) 박스 수, 출고창고, 재고단위, 출고일자 단일성
 */

import { EXPECTED_STOCK_UNIT, EXPECTED_WAREHOUSE } from "@/lib/domain/constants";
import type {
  DeliveryPoint,
  ExcludedRow,
  ExclusionReason,
  Issue,
  ShipmentParseResult,
} from "@/lib/domain/types";
import {
  cleanAddress,
  extractMemoBoxes,
  extractTags,
  extractTonnageLimit,
  parseDeliveryName,
  pointKey,
} from "@/lib/structure/delivery-name";
import { resolveTime } from "@/lib/structure/merge";
import { validateWindows } from "@/lib/structure/time-window";
import { num, readSheet, readWorkbook, str, type SheetTable } from "./workbook";

/** PRD §5.1 — 25개 컬럼 */
export const SHIPMENT_COLUMNS = [
  "출고일자",
  "고객코드",
  "고객",
  "납품처코드",
  "납품처우편번호",
  "납품처",
  "납품처주소",
  "납품처담당자",
  "납품처전화번호",
  "납품처팩스번호",
  "납품시간",
  "납품처휴대폰번호",
  "배송방법코드",
  "배송방법",
  "품번",
  "품명",
  "규격",
  "관리단위",
  "재고단위수량",
  "출고수량",
  "재고단위",
  "비고(건)",
  "비고(내역)",
  "출고창고코드",
  "출고창고",
] as const;

/** 배차 로직이 반드시 필요로 하는 컬럼 — 없으면 업로드 거부 (FR-02) */
const REQUIRED_COLUMNS = [
  "출고일자",
  "납품처",
  "납품처주소",
  "납품시간",
  "배송방법",
  "재고단위수량",
] as const;

function classifyExclusion(배송방법: string): ExclusionReason {
  if (배송방법.includes("픽업")) return "픽업";
  if (배송방법.includes("이체")) return "이체";
  if (배송방법.includes("취소")) return "취소";
  return "기타";
}

export async function parseShipment(data: ArrayBuffer | Buffer): Promise<ShipmentParseResult> {
  const wb = await readWorkbook(data);
  const table = readSheet(wb);
  return buildShipmentResult(table);
}

export function buildShipmentResult(table: SheetTable): ShipmentParseResult {
  const issues: Issue[] = [];

  // ── 1. 필수 컬럼 검증 (FR-02)
  const missing = REQUIRED_COLUMNS.filter((c) => !table.headers.includes(c));
  if (missing.length) {
    throw new Error(
      `출고등록현황 필수 컬럼이 없습니다: ${missing.join(", ")}\n` +
        `발견된 컬럼: ${table.headers.join(", ")}`
    );
  }
  const optionalMissing = SHIPMENT_COLUMNS.filter((c) => !table.headers.includes(c));
  if (optionalMissing.length) {
    issues.push({
      level: "warning",
      code: "FR-02",
      message: `표준 컬럼 ${optionalMissing.length}개가 없습니다 — 해당 정보는 비워집니다`,
      detail: optionalMissing.join(", "),
    });
  }

  // ── 2. 배차 대상 필터 (R-01)
  const excluded: ExcludedRow[] = [];
  const targets: { rowNo: number; rec: Record<string, unknown> }[] = [];
  const dates = new Set<string>();

  table.rows.forEach((rec, i) => {
    const rowNo = table.rowNos[i];
    const 출고일자 = str(rec["출고일자"] as never);
    if (출고일자) dates.add(출고일자);

    const 배송방법 = str(rec["배송방법"] as never);
    const boxes = num(rec["재고단위수량"] as never) ?? 0;

    if (배송방법) {
      excluded.push({
        rowNo,
        납품처: str(rec["납품처"] as never) ?? "(미상)",
        배송방법,
        reason: classifyExclusion(배송방법),
        boxes,
      });
      return;
    }
    targets.push({ rowNo, rec });
  });

  // ── 출고일자 단일성 (FR-04)
  const dateList = [...dates].sort();
  const date = dateList[0] ?? "";
  if (dateList.length > 1) {
    issues.push({
      level: "warning",
      code: "FR-04",
      message: `출고일자가 ${dateList.length}종 혼재합니다 — ${dateList[0]} 기준으로 처리합니다`,
      detail: dateList.join(", "),
    });
  }
  if (!date) {
    issues.push({ level: "error", code: "FR-04", message: "출고일자를 읽지 못했습니다" });
  }

  // ── 3. 납품처 + 주소 단위 합산 (R-02)
  interface Bucket {
    raw납품처: string;
    address: string;
    boxes: number;
    rowNos: number[];
    contacts: string[];
    memos: Set<string>;
    memoDetails: Set<string>;
    timeColumns: Set<string>;
    units: Set<string>;
    warehouses: Set<string>;
    itemNames: Set<string>;
  }

  const buckets = new Map<string, Bucket>();

  for (const { rowNo, rec } of targets) {
    const 납품처 = str(rec["납품처"] as never);
    const 주소 = str(rec["납품처주소"] as never);

    if (!납품처 || !주소) {
      issues.push({
        level: "error",
        code: "FR-02",
        message: "납품처 또는 주소가 비어 있어 제외했습니다",
        subject: `${rowNo}행`,
      });
      continue;
    }

    const key = pointKey(납품처, 주소);
    let b = buckets.get(key);
    if (!b) {
      b = {
        raw납품처: 납품처,
        address: 주소,
        boxes: 0,
        rowNos: [],
        contacts: [],
        memos: new Set(),
        memoDetails: new Set(),
        timeColumns: new Set(),
        units: new Set(),
        warehouses: new Set(),
        itemNames: new Set(),
      };
      buckets.set(key, b);
    }

    b.boxes += num(rec["재고단위수량"] as never) ?? 0;
    b.rowNos.push(rowNo);

    const phone = str(rec["납품처휴대폰번호"] as never) ?? str(rec["납품처전화번호"] as never);
    if (phone && !b.contacts.includes(phone)) b.contacts.push(phone);

    const memo = str(rec["비고(건)"] as never);
    if (memo) b.memos.add(memo);
    const memoDetail = str(rec["비고(내역)"] as never);
    if (memoDetail) b.memoDetails.add(memoDetail);

    const t = str(rec["납품시간"] as never);
    if (t) b.timeColumns.add(t);

    const unit = str(rec["재고단위"] as never);
    if (unit) b.units.add(unit);

    const wh = str(rec["출고창고"] as never);
    if (wh) b.warehouses.add(wh);

    const item = str(rec["품명"] as never);
    if (item) b.itemNames.add(item);
  }

  // ── 4~5. 구조화 + 교차 검증
  const points: DeliveryPoint[] = [];

  for (const [id, b] of buckets) {
    const parsedName = parseDeliveryName(b.raw납품처);

    // 납품시간 컬럼이 그룹 내에서 여러 값이면 가장 이른 마감 쪽을 대표로 쓴다
    const timeColumnList = [...b.timeColumns];
    if (timeColumnList.length > 1) {
      issues.push({
        level: "warning",
        code: "FR-11",
        message: "동일 납품처에 납품시간 값이 여러 개입니다 — 첫 값을 사용합니다",
        subject: parsedName.company,
        detail: timeColumnList.join(" / "),
      });
    }
    const columnRaw = timeColumnList[0] ?? null;

    const time = resolveTime(columnRaw, parsedName.conditionText);

    const windowError = validateWindows(time.windows);
    if (windowError) {
      issues.push({
        level: "error",
        code: "FR-17",
        message: `시간창 형식 오류로 배차에 반영하지 않습니다 — ${windowError}`,
        subject: parsedName.company,
        detail: `컬럼 "${columnRaw ?? ""}" / 원문 "${parsedName.conditionText}"`,
      });
      time.windows = [];
    }

    const memoList = [...b.memos];
    const detailList = [...b.memoDetails];
    const tags = extractTags(parsedName.conditionText, ...memoList, ...detailList);
    const maxTonnage = extractTonnageLimit(parsedName.conditionText, ...memoList);

    /**
     * 비고(건) 박스 수 교차 검증 (§5.3-(5))
     *
     * 실데이터에는 두 가지 기재 방식이 섞여 있다.
     *   - 총량 기재  : `ok/1061박스` — 부가 설명에 다른 숫자가 섞이기도 한다
     *                  (`ok/1061박스(페르디 80박스-1빠적재)`)
     *   - 분할 기재  : SPC 양지1센터처럼 오더별로 32/48/80/85로 쪼개 적음
     * 따라서 "후보 중 하나가 합계와 같거나" 또는 "후보 총합이 합계와 같으면" 일치로 본다.
     */
    const uniqueMemoNums = [...new Set(memoList.flatMap((m) => extractMemoBoxes(m)))];
    const memoSum = uniqueMemoNums.reduce((s, n) => s + n, 0);
    const matched =
      uniqueMemoNums.length > 0 &&
      (uniqueMemoNums.includes(b.boxes) || memoSum === b.boxes);

    const memoBoxes: number | null =
      uniqueMemoNums.length === 0 ? null : matched ? b.boxes : memoSum;

    if (memoBoxes !== null && !matched) {
      issues.push({
        level: "warning",
        code: "FR-07",
        message: `비고의 박스 수와 재고단위수량 합계(${b.boxes})가 맞지 않습니다`,
        subject: parsedName.company,
        detail: `비고 추출값 [${uniqueMemoNums.join(", ")}] · 합계 ${memoSum} / ${memoList.join(" / ")}`,
      });
    }

    // 재고단위 검증 (FR-06)
    const badUnits = [...b.units].filter((u) => u !== EXPECTED_STOCK_UNIT);
    if (badUnits.length) {
      issues.push({
        level: "warning",
        code: "FR-06",
        message: `재고단위가 ${EXPECTED_STOCK_UNIT}이 아닌 행이 있습니다`,
        subject: parsedName.company,
        detail: badUnits.join(", "),
      });
    }

    // 출고창고 검증 (FR-05)
    const badWarehouses = [...b.warehouses].filter((w) => w !== EXPECTED_WAREHOUSE);
    if (badWarehouses.length) {
      issues.push({
        level: "warning",
        code: "FR-05",
        message: `${EXPECTED_WAREHOUSE} 이외의 창고 출고 행이 있습니다`,
        subject: parsedName.company,
        detail: badWarehouses.join(", "),
      });
    }

    // 시간창 불일치 (§5.3-(1))
    if (time.mismatch === "boundary") {
      issues.push({
        level: "warning",
        code: "FR-11",
        message: "납품시간 컬럼과 납품처명 원문의 시간 경계가 다릅니다",
        subject: parsedName.company,
        detail: time.note,
      });
    } else if (time.mismatch === "missing") {
      issues.push({
        level: "warning",
        code: "FR-11",
        message: "납품시간 컬럼이 비어 있어 납품처명에서 시간창을 회수했습니다",
        subject: parsedName.company,
        detail: time.note,
      });
    } else if (time.mismatch === "refine") {
      issues.push({
        level: "info",
        code: "FR-12",
        message: "납품처명 원문에서 배제 구간을 찾아 시간창을 분리했습니다",
        subject: parsedName.company,
        detail: time.note,
      });
    }

    if (time.assumedOperating) {
      issues.push({
        level: "warning",
        code: "FR-12",
        message: `배제 구간만 주어져 운영 시간 08:00~18:00을 가정했습니다`,
        subject: parsedName.company,
        detail: time.note,
      });
    }

    points.push({
      id,
      raw납품처: b.raw납품처,
      address: b.address,
      cleanAddress: cleanAddress(b.address),
      parsedName,
      boxes: b.boxes,
      rowNos: b.rowNos,
      contact: b.contacts[0] ?? null,
      memos: memoList,
      memoBoxes,
      time,
      tags,
      maxTonnage,
    });
  }

  points.sort((a, b) => b.boxes - a.boxes);

  const totalBoxes = points.reduce((s, p) => s + p.boxes, 0);

  return {
    date,
    totalRows: table.rows.length,
    targetRows: targets.length,
    excluded,
    points,
    totalBoxes,
    issues,
  };
}
