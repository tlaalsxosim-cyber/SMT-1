/**
 * 납품 시작 시각 처리 검증 (R-16)
 *
 * 원칙: **시작 시각이 등록된 업체는 등록값 그대로**, 누락된 업체만 08:00로 채운다.
 * 이 스크립트는 55개 납품처를 두 부류로 나눠 출력해 그 원칙이 지켜지는지 눈으로 확인시킨다.
 *
 *   npm run start-check
 */
import { readFileSync } from "node:fs";

import { parseShipment } from "../src/lib/parse/shipment";
import {
  formatWindows,
  normalizeTimeText,
  parseTimeToken,
  toHHMM,
} from "../src/lib/structure/time-window";
import type { TimeWindow } from "../src/lib/domain/types";

const minStart = (ws: TimeWindow[]) => Math.min(...ws.map((w) => w.start));

async function main() {
  const ship = await parseShipment(readFileSync("docs/출고등록현황.xlsx"));
  const withWindows = ship.points.filter((p) => p.time.windows.length > 0);

  const registered = withWindows.filter((p) => p.time.hasExplicitStart);
  const filled = withWindows.filter((p) => !p.time.hasExplicitStart);

  const line = (n = 104) => console.log("─".repeat(n));
  const show = (p: (typeof withWindows)[number]) => {
    const src = [p.time.columnRaw, p.parsedName.conditionText].filter(Boolean).join("  |  ");
    console.log(
      `  ${p.parsedName.company.padEnd(20).slice(0, 20)} ` +
        `${formatWindows(p.time.windows).padEnd(30)} ← ${src}`
    );
  };

  line();
  console.log(`① 시작 시각이 등록된 업체 — 등록값 그대로 사용 (${registered.length}곳)`);
  line();
  for (const p of registered.sort((a, b) => minStart(a.time.windows) - minStart(b.time.windows))) {
    show(p);
  }

  line();
  console.log(`② 시작 시각이 누락된 업체 — 08:00으로 채움 (${filled.length}곳)`);
  line();
  for (const p of filled) show(p);

  line();
  console.log("검증");
  line();

  const starts = new Set(registered.map((p) => toHHMM(minStart(p.time.windows))));
  console.log("  등록 업체의 시작 시각 종류 :", [...starts].sort().join(", "));

  /**
   * 등록값이 덮이지 않았는지 확인한다.
   * 채택된 시간창의 시작 시각이, 채택된 원문에서 읽히는 첫 시각 토큰과 같아야 한다.
   * (문자열에 "8"이 있는지 보는 식의 어림짐작은 `8~10:30` 같은 표기를 오탐한다.)
   */
  const adoptedSource = (p: (typeof withWindows)[number]) =>
    p.time.adopted === "column" ? (p.time.columnRaw ?? "") : p.parsedName.conditionText;

  const overwritten = registered.filter((p) => {
    const token = parseTimeToken(normalizeTimeText(adoptedSource(p)));
    if (!token) return true; // 원문에서 시작을 못 읽었는데 등록으로 분류됐다면 이상하다
    return token.minutes !== minStart(p.time.windows);
  });

  console.log("  등록값이 덮인 건          :", overwritten.length, "건");
  for (const p of overwritten) {
    console.log(
      `     ${p.parsedName.company} — 원문 "${adoptedSource(p)}" → ${formatWindows(p.time.windows)}`
    );
  }

  const badFilled = filled.filter((p) => minStart(p.time.windows) !== 8 * 60);
  console.log("  누락인데 08:00이 아닌 건  :", badFilled.length, "건");
  if (badFilled.length) badFilled.forEach(show);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
