import { readFileSync, writeFileSync } from "node:fs";
import { readSheet, readWorkbook } from "@/lib/parse/workbook";
import { parsePalletMaster } from "@/lib/parse/pallet";

async function main() {
  const buf = readFileSync("docs/평택센터_파렛트적재기준.xlsx");
  const wb = await readWorkbook(buf);
  const table = readSheet(wb);
  const { specs, issues } = parsePalletMaster(table);

  console.error(`품목 ${specs.length}건, 이슈 ${issues.length}건`);

  const lines: string[] = [];
  lines.push("/**");
  lines.push(" * 파렛트 적재 기준 마스터 스냅샷 (R-19)");
  lines.push(" *");
  lines.push(" * `docs/평택센터_파렛트적재기준.xlsx`(현업 제공, 2026-09-23 수령)를");
  lines.push(" * `src/lib/parse/pallet.ts`의 `parsePalletMaster`로 읽어 구운 정적 데이터다.");
  lines.push(" * `warehouse-address.ts`의 `WAREHOUSE_ADDRESS_BY_SITE_CODE`와 같은 방식 —");
  lines.push(" * 세션마다 다시 업로드받지 않고 소스에 내장해 둔다.");
  lines.push(" *");
  lines.push(" * 원본이 갱신되면 새 파일을 `docs/평택센터_파렛트적재기준.xlsx`로 교체한 뒤");
  lines.push(" * `npm run gen:pallet-spec`을 다시 돌려 이 파일을 재생성한다.");
  lines.push(" */");
  lines.push('import type { PalletSpec } from "./types";');
  lines.push("");
  lines.push("export const PALLET_SPEC_BY_CODE: Record<string, PalletSpec> = {");
  for (const s of specs) {
    lines.push(
      `  ${JSON.stringify(s.품번)}: { 품번: ${JSON.stringify(s.품번)}, 품명: ${JSON.stringify(s.품명)}, n11: ${s.n11 === null ? "null" : s.n11}, n12: ${s.n12 === null ? "null" : s.n12} },`
    );
  }
  lines.push("};");
  lines.push("");

  writeFileSync("src/lib/domain/pallet-spec.ts", lines.join("\n"), "utf-8");
  console.error("작성 완료: src/lib/domain/pallet-spec.ts");
}

main();
