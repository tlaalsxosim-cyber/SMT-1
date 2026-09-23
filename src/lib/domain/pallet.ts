/**
 * 파렛트수 계산 (R-19)
 *
 * 품번마다 파렛트 1개당 적재수량이 다르므로, 배송지 전체 박스 합계를 평균값으로
 * 나누면 안 된다 — 품번별로 올림 나눗셈한 뒤 더해야 한다.
 */

import { DEFAULT_PALLET_TYPE } from "./constants";
import { PALLET_SPEC_BY_CODE } from "./pallet-spec";
import type { PalletSpec } from "./types";

export interface PalletUsage {
  /** 예상 파렛트수. 품목 중 하나라도 계산할 수 없으면 null(미상) — 모르면 제약을 걸지 않는다 */
  count: number | null;
  /** 파렛트 마스터에서 적재수량을 찾지 못한 품번 */
  unresolved: string[];
}

/**
 * 배송지의 품번별 수량을 파렛트수로 환산한다.
 *
 * 기본 파렛트 유형(`DEFAULT_PALLET_TYPE`)에 값이 없는 품번은 다른 유형으로 폴백한다 —
 * 둘 중 하나라도 있으면 최선의 근사치를 쓴다. 둘 다 없거나 마스터에 품번이 없으면
 * `unresolved`에 남기고, 그런 품번이 하나라도 있으면 전체 `count`를 null로 둔다
 * (부분 합계는 "이 정도면 실을 수 있다"는 잘못된 확신을 줄 수 있다).
 */
export function computePalletUsage(
  items: { 품번: string; boxes: number }[],
  specBy: Record<string, PalletSpec> = PALLET_SPEC_BY_CODE,
  type: "N11" | "N12" = DEFAULT_PALLET_TYPE
): PalletUsage {
  if (items.length === 0) return { count: null, unresolved: [] };

  const unresolved: string[] = [];
  let count = 0;

  for (const item of items) {
    const spec = specBy[item.품번];
    const primary = type === "N11" ? spec?.n11 : spec?.n12;
    const fallback = type === "N11" ? spec?.n12 : spec?.n11;
    const qty = primary ?? fallback ?? null;

    if (!spec || qty === null || qty <= 0) {
      unresolved.push(item.품번);
      continue;
    }
    count += Math.ceil(item.boxes / qty);
  }

  return { count: unresolved.length > 0 ? null : count, unresolved };
}
