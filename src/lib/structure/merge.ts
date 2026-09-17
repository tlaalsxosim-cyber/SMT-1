/**
 * 시간창 세 소스 대조·병합 (FR-11 / PRD §5.3-(1) / OI-3 확정 2026-09-17)
 *
 * 비고(건, AH열) · 납품처명 조건 텍스트(J열) · 납품시간 컬럼(R열) 순으로 우선순위를 둔다.
 * 현업 확정: 비고(건)은 담당자가 그때그때 손으로 갱신하는 최신 지시라 가장 신뢰하고,
 * 그다음 납품처명에 박힌 조건, 마지막으로 ERP 납품시간 컬럼을 3순위 보조값으로 쓴다
 * (비고·납품처명 둘 다 시간 정보가 없을 때만 컬럼을 본다).
 *
 * 먼저 컬럼·납품처명 두 소스를 기존 방식대로(더 엄격한 쪽 채택) 병합한 뒤,
 * 비고(건)에 시간 정보가 있으면 그 결과를 최종적으로 덮어쓴다 — 비고가 없는 압도적
 * 다수의 행은 이 단계가 그대로 통과되어 기존 동작과 동일하다.
 *
 * 불일치는 세 종류로 나눈다.
 *   - boundary : 외곽 경계가 다름          → 마감/시작 오차. 시간 위반 직결 (경고)
 *   - missing  : 컬럼이 비어 시간 정보를 다른 소스에서 회수 (경고)
 *   - refine   : 경계는 같고 내부만 세분화 → 점심 배제 등 (정보)
 */

import type { TimeWindowResolution, TimeWindow } from "@/lib/domain/types";
import {
  envelope,
  extractRemarkTimePhrase,
  formatWindows,
  parseTimeText,
  windowSpan,
  windowsEqual,
} from "./time-window";

export type MismatchKind = TimeWindowResolution["mismatch"];

export type ResolvedTime = TimeWindowResolution;

function sameEnvelope(a: TimeWindow[], b: TimeWindow[]): boolean {
  const ea = envelope(a);
  const eb = envelope(b);
  if (!ea || !eb) return false;
  return ea.start === eb.start && ea.end === eb.end;
}

type TimeBase = Pick<
  ResolvedTime,
  | "columnRaw"
  | "fromColumn"
  | "nameRaw"
  | "fromName"
  | "remarkRaw"
  | "fromRemark"
  | "advisory"
  | "assumedOperating"
  | "hasExplicitStart"
>;

/** 컬럼(R열)·납품처명(J열) 두 소스만 병합 — 어긋나면 더 엄격한(좁은) 쪽 채택 */
function resolveColumnAndName(
  base: TimeBase,
  fromColumn: TimeWindow[],
  fromName: TimeWindow[]
): ResolvedTime {
  // 양쪽 모두 시간 정보 없음 → 무제약
  if (fromColumn.length === 0 && fromName.length === 0) {
    return { ...base, windows: [], conflict: false, mismatch: "none", adopted: "none", note: "시간 제약 없음" };
  }

  // 한쪽만 존재 → 있는 쪽 채택
  if (fromColumn.length === 0) {
    return {
      ...base,
      windows: fromName,
      conflict: true,
      mismatch: "missing",
      adopted: "name",
      note: `납품시간 컬럼이 비어 있어 납품처명에서 회수: ${formatWindows(fromName)}`,
    };
  }
  if (fromName.length === 0) {
    return {
      ...base,
      windows: fromColumn,
      conflict: false,
      mismatch: "none",
      adopted: "column",
      note: `납품시간 컬럼 채택: ${formatWindows(fromColumn)}`,
    };
  }

  // 양쪽 모두 존재하고 동일 → 일치
  if (windowsEqual(fromColumn, fromName)) {
    return {
      ...base,
      windows: fromColumn,
      conflict: false,
      mismatch: "none",
      adopted: "both",
      note: `두 소스 일치: ${formatWindows(fromColumn)}`,
    };
  }

  // 엄격한(좁은) 쪽 채택
  const colSpan = windowSpan(fromColumn);
  const namSpan = windowSpan(fromName);
  const adoptName = namSpan <= colSpan;
  const windows = adoptName ? fromName : fromColumn;

  const mismatch: MismatchKind = sameEnvelope(fromColumn, fromName) ? "refine" : "boundary";

  const note =
    mismatch === "boundary"
      ? `경계 불일치 — 컬럼 ${formatWindows(fromColumn)} / 원문 ${formatWindows(
          fromName
        )} → 엄격한 ${adoptName ? "원문" : "컬럼"} 채택`
      : `배제 구간 세분화 — 컬럼 ${formatWindows(fromColumn)} → 원문 ${formatWindows(fromName)}`;

  return {
    ...base,
    windows,
    conflict: mismatch === "boundary",
    mismatch,
    adopted: adoptName ? "name" : "column",
    note,
  };
}

/**
 * @param columnRaw     납품시간 컬럼(R열) 원문 (`~13:00`, `8:00~14:00`, null) — 3순위
 * @param nameCondition 납품처명(J열) 4번째 이후 토큰 (`8~11또는13~14:30(점심11:30~13)`) — 2순위
 * @param remarkRaw     비고(건, AH열) 원문 — 1순위. 시간 정보가 없으면 무시된다
 */
export function resolveTime(
  columnRaw: string | null | undefined,
  nameCondition: string,
  remarkRaw?: string | null
): ResolvedTime {
  const col = parseTimeText(columnRaw);
  const nam = parseTimeText(nameCondition);
  // 비고(건)은 자유 텍스트라 시간 표현처럼 보이는 조각만 도려내 파싱한다 (전화번호·박스 수 오탐 방지)
  const rem = parseTimeText(extractRemarkTimePhrase(remarkRaw));

  const fromColumn = col.windows;
  const fromName = nam.windows;
  const fromRemark = rem.windows;

  const base: TimeBase = {
    columnRaw: columnRaw ?? null,
    fromColumn,
    nameRaw: nameCondition ?? "",
    fromName,
    remarkRaw: remarkRaw ?? null,
    fromRemark,
    advisory: col.advisory || nam.advisory || rem.advisory,
    assumedOperating: col.assumedOperating || nam.assumedOperating || rem.assumedOperating,
    // 세 소스 중 하나라도 시작 시각을 명시했으면 명시된 것으로 본다
    hasExplicitStart: col.explicitStart || nam.explicitStart || rem.explicitStart,
  };

  const colName = resolveColumnAndName(base, fromColumn, fromName);

  // 비고(건)에 시간 정보가 없으면 기존 컬럼·납품처명 병합 결과를 그대로 쓴다 (하위 호환)
  if (fromRemark.length === 0) return colName;

  // 컬럼·납품처명 둘 다 없어 비고(건)이 유일한 소스
  if (colName.windows.length === 0) {
    return {
      ...colName,
      windows: fromRemark,
      conflict: false,
      mismatch: "none",
      adopted: "remark",
      note: `비고(건) 채택: ${formatWindows(fromRemark)}`,
    };
  }

  // 비고(건)이 컬럼·납품처명 병합 결과와 같음 → 일치
  if (windowsEqual(colName.windows, fromRemark)) {
    return { ...colName, adopted: "remark", note: `비고(건)과 일치: ${formatWindows(fromRemark)}` };
  }

  // 비고(건)이 다름 → 1순위이므로 무조건 비고(건)을 채택한다
  const mismatch: MismatchKind = sameEnvelope(colName.windows, fromRemark) ? "refine" : "boundary";
  const note =
    mismatch === "boundary"
      ? `비고(건)이 다름 — 컬럼/납품처명 ${formatWindows(colName.windows)} / 비고 ${formatWindows(
          fromRemark
        )} → 비고(건) 채택`
      : `비고(건)이 세분화 — 컬럼/납품처명 ${formatWindows(colName.windows)} → 비고 ${formatWindows(fromRemark)}`;

  return {
    ...colName,
    windows: fromRemark,
    conflict: mismatch === "boundary",
    mismatch,
    adopted: "remark",
    note,
  };
}
