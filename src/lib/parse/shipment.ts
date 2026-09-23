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
import { computePalletUsage } from "@/lib/domain/pallet";
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
  "출고장소코드",
  "출고장소",
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

/**
 * `납품시간` 컬럼 별칭 — `납품처메일주소` (FR-11 확장, 2026-09-21)
 *
 * ERP 원본 최신판은 `납품시간` 컬럼이 통째로 없고, 같은 자리를 `납품처메일주소`라는
 * 이름의 컬럼이 대신한다. 컬럼명만 바뀌었을 뿐 값은 그대로 시간창 문자열이다
 * ("~12:00", "8:00~9:30" 등) — 실데이터 336행 전량에 실제 이메일 형식(`@` 포함)이
 * 하나도 없음을 확인했다. `납품시간` 컬럼이 이미 있는 파일(구 양식)에서는 이 별칭을
 * 쓰지 않고 그 컬럼을 그대로 쓴다 — 둘 다 있는 경우를 대비해 `납품시간`을 우선한다.
 */
const DELIVERY_TIME_ALIAS_COLUMN = "납품처메일주소";

function withDeliveryTimeAlias(table: SheetTable, issues: Issue[]): SheetTable {
  if (table.headers.includes("납품시간") || !table.headers.includes(DELIVERY_TIME_ALIAS_COLUMN)) {
    return table;
  }
  issues.push({
    level: "info",
    code: "FR-11",
    message: `\`납품시간\` 컬럼이 없어 \`${DELIVERY_TIME_ALIAS_COLUMN}\` 컬럼 값을 납품시간으로 대신 씁니다`,
  });
  return {
    ...table,
    headers: table.headers.map((h) => (h === DELIVERY_TIME_ALIAS_COLUMN ? "납품시간" : h)),
    rows: table.rows.map((r) => {
      const { [DELIVERY_TIME_ALIAS_COLUMN]: aliasValue, ...rest } = r;
      return { ...rest, 납품시간: aliasValue };
    }),
  };
}

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

export function buildShipmentResult(rawTable: SheetTable): ShipmentParseResult {
  const issues: Issue[] = [];
  const table = withDeliveryTimeAlias(rawTable, issues);

  // ── 1. 필수 컬럼 검증 (FR-02)
  const missing = REQUIRED_COLUMNS.filter((c) => !table.headers.includes(c));
  if (missing.length) {
    throw new Error(
      `배차정보 필수 컬럼이 없습니다: ${missing.join(", ")}\n` +
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
    /** 품번 → 합산 재고단위수량·규격 (R-19 파렛트수 계산, R-21 중량 기준 분류용) */
    items: Map<string, { boxes: number; spec: string | null }>;
    siteCodes: Set<string>;
    siteNames: Set<string>;
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
        items: new Map(),
        siteCodes: new Set(),
        siteNames: new Set(),
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

    // 품번별 수량·규격 누적 (R-19 파렛트수, R-21 중량 기준 분류) — 품목마다 값이 다르므로 박스 합계만으로는 계산할 수 없다
    const 품번 = str(rec["품번"] as never);
    if (품번) {
      const prev = b.items.get(품번);
      const rowBoxes = num(rec["재고단위수량"] as never) ?? 0;
      b.items.set(품번, {
        boxes: (prev?.boxes ?? 0) + rowBoxes,
        spec: prev?.spec ?? str(rec["규격"] as never),
      });
    }

    // 출고장소코드 (BA열) — 출고 창고 주소지 마스터의 조인 키 (FR-54)
    const siteCode = str(rec["출고장소코드"] as never);
    if (siteCode) b.siteCodes.add(siteCode);
    const siteName = str(rec["출고장소"] as never);
    if (siteName) b.siteNames.add(siteName);
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
    const memoList = [...b.memos];
    // 비고(건)은 1순위 시간 소스다 (OI-3 확정) — 그룹 내 첫 값을 대표로 쓴다
    const remarkRaw = memoList[0] ?? null;

    const time = resolveTime(columnRaw, parsedName.conditionText, remarkRaw);

    const windowError = validateWindows(time.windows);
    if (windowError) {
      issues.push({
        level: "error",
        code: "FR-17",
        message: `시간창 형식 오류로 배차에 반영하지 않습니다 — ${windowError}`,
        subject: parsedName.company,
        detail: `컬럼 "${columnRaw ?? ""}" / 원문 "${parsedName.conditionText}" / 비고 "${remarkRaw ?? ""}"`,
      });
      time.windows = [];
    }

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

    // 출고장소코드(BA열)가 같은 납품처 안에서 갈리면 대표값을 정할 수 없다 (FR-54)
    if (b.siteCodes.size > 1) {
      issues.push({
        level: "warning",
        code: "FR-54",
        message: "동일 납품처에 출고장소코드가 여러 개입니다 — 첫 값을 사용합니다",
        subject: parsedName.company,
        detail: [...b.siteCodes].join(" / "),
      });
    }

    // 시간창 불일치 — 비고(건) > 납품처명 > 납품시간 컬럼 순으로 채택 (§5.3-(1) / OI-3)
    if (time.mismatch === "boundary") {
      issues.push({
        level: "warning",
        code: "FR-11",
        message: "시간창 소스 간 경계가 달라 우선순위대로 채택했습니다",
        subject: parsedName.company,
        detail: time.note,
      });
    } else if (time.mismatch === "missing") {
      issues.push({
        level: "warning",
        code: "FR-11",
        message: "납품시간 컬럼이 비어 있어 다른 소스에서 시간창을 회수했습니다",
        subject: parsedName.company,
        detail: time.note,
      });
    } else if (time.mismatch === "refine") {
      issues.push({
        level: "info",
        code: "FR-12",
        message: "다른 소스에서 배제 구간을 찾아 시간창을 분리했습니다",
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

    const items = [...b.items].map(([품번, v]) => ({ 품번, boxes: v.boxes, spec: v.spec }));

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
      출고장소코드: [...b.siteCodes][0] ?? null,
      출고장소: [...b.siteNames][0] ?? null,
      items,
      pallets: computePalletUsage(items).count,
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
