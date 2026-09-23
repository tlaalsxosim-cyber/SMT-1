/**
 * 파렛트 적재 기준 마스터 파서 (R-19)
 *
 * `docs/평택센터_파렛트적재기준.xlsx`를 읽어 품번별 파렛트(N11형·N12형) 적재수량을
 * 뽑는다. 이 파서의 결과는 실행마다 업로드받지 않고 `src/lib/domain/pallet-spec.ts`에
 * 스냅샷으로 한 번 구워 둔다 — `warehouse-address.ts`의 `WAREHOUSE_ADDRESS_BY_SITE_CODE`와
 * 같은 방식이다. 원본이 갱신되면 이 파서로 다시 돌려 스냅샷을 재생성한다.
 */

import type { Issue, PalletSpec } from "@/lib/domain/types";
import { str, type Cell, type SheetTable } from "./workbook";

export const PALLET_COLUMNS = ["품번", "품명", "N11", "N12"] as const;

export interface PalletMasterParseResult {
  specs: PalletSpec[];
  issues: Issue[];
}

/**
 * N11/N12 셀 전용 숫자 파서.
 *
 * 원본 파일에 공백 문자(`" "`)만 든 셀이 9개 있다 — `num()`을 그대로 쓰면
 * `Number("")`가 0이 되어 "적재수량 0"으로 잘못 읽힌다. `str()`로 먼저
 * 공백 여부를 가린 뒤에만 숫자로 바꾼다.
 */
function palletQty(v: Cell | undefined): number | null {
  const s = str(v);
  if (!s) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function parsePalletMaster(table: SheetTable): PalletMasterParseResult {
  const issues: Issue[] = [];

  const missing = PALLET_COLUMNS.filter((c) => !table.headers.includes(c));
  if (missing.length) {
    throw new Error(
      `파렛트 적재 기준 필수 컬럼이 없습니다: ${missing.join(", ")}\n` +
        `발견된 컬럼: ${table.headers.join(", ")}`
    );
  }

  const specs: PalletSpec[] = [];
  const seen = new Set<string>();

  table.rows.forEach((rec, i) => {
    const rowNo = table.rowNos[i];
    const 품번 = str(rec["품번"]);
    if (!품번) return; // 품번 없는 행(소계·메모 등)은 건너뛴다

    if (seen.has(품번)) {
      issues.push({
        level: "warning",
        code: "R-19",
        message: "품번이 중복됩니다 — 먼저 나온 행을 씁니다",
        subject: 품번,
        detail: `${rowNo}행`,
      });
      return;
    }
    seen.add(품번);

    const n11 = palletQty(rec["N11"]);
    const n12 = palletQty(rec["N12"]);
    if (n11 === null && n12 === null) {
      issues.push({
        level: "info",
        code: "R-19",
        message: "N11/N12 적재수량이 모두 없습니다 — 이 품번은 파렛트수를 계산하지 않습니다",
        subject: 품번,
        detail: `${rowNo}행`,
      });
    }

    specs.push({ 품번, 품명: str(rec["품명"]) ?? "", n11, n12 });
  });

  return { specs, issues };
}
