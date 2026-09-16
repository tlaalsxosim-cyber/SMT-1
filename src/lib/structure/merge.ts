/**
 * 시간창 두 소스 대조·병합 (FR-11 / PRD §5.3-(1))
 *
 * 납품시간 컬럼과 납품처명 조건 텍스트를 각각 해석한 뒤,
 * 어긋나면 **더 엄격한(가용 시간이 좁은) 쪽을 채택하고 불일치 플래그**를 세운다.
 * 채택 근거는 note에 남겨 화면·엑셀에 원문과 나란히 표시한다 (FR-18).
 *
 * 불일치는 세 종류로 나눈다.
 *   - boundary : 외곽 경계가 다름          → 마감/시작 오차. 시간 위반 직결 (경고)
 *   - missing  : 한쪽만 시간 정보를 가짐   → 컬럼 결손 회수 (경고)
 *   - refine   : 경계는 같고 내부만 세분화 → 점심 배제 등 (정보)
 */

import type { TimeWindowResolution, TimeWindow } from "@/lib/domain/types";
import {
  envelope,
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

/**
 * @param columnRaw     납품시간 컬럼 원문 (`~13:00`, `8:00~14:00`, null)
 * @param nameCondition 납품처명 4번째 이후 토큰 (`8~11또는13~14:30(점심11:30~13)`)
 */
export function resolveTime(
  columnRaw: string | null | undefined,
  nameCondition: string
): ResolvedTime {
  const col = parseTimeText(columnRaw);
  const nam = parseTimeText(nameCondition);

  const fromColumn = col.windows;
  const fromName = nam.windows;

  const base = {
    columnRaw: columnRaw ?? null,
    fromColumn,
    nameRaw: nameCondition ?? "",
    fromName,
    advisory: col.advisory || nam.advisory,
    assumedOperating: col.assumedOperating || nam.assumedOperating,
    // 두 소스 중 하나라도 시작 시각을 명시했으면 명시된 것으로 본다
    hasExplicitStart: col.explicitStart || nam.explicitStart,
  };

  // 양쪽 모두 시간 정보 없음 → 무제약
  if (fromColumn.length === 0 && fromName.length === 0) {
    return {
      ...base,
      windows: [],
      conflict: false,
      mismatch: "none",
      adopted: "none",
      note: "시간 제약 없음",
    };
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
