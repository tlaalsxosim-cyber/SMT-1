/**
 * 엑셀 워크북 공통 유틸
 *
 * exceljs의 row.values는 1-based sparse 배열이라 0번 자리에 null이 들어온다.
 * 여기서 헤더 기준 객체 배열로 정규화해 파서들이 컬럼명으로 접근하게 한다.
 */

import ExcelJS from "exceljs";

export type Cell = string | number | null;

export interface SheetTable {
  sheetName: string;
  headers: string[];
  rows: Record<string, Cell>[];
  /** rows[i]가 원본 엑셀의 몇 번째 행인지 (헤더 = 1) */
  rowNos: number[];
}

/** exceljs 셀 값을 문자열/숫자/null로 눌러 담는다 */
function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof Date) return v.toISOString();

  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    // 하이퍼링크 셀 / 리치 텍스트 셀
    if (typeof o.text === "string") return o.text;
    if (typeof o.result === "string" || typeof o.result === "number") return o.result as Cell;
    if (Array.isArray(o.richText)) {
      return (o.richText as { text?: string }[]).map((r) => r.text ?? "").join("");
    }
    if (typeof o.formula === "string") return null;
  }

  const s = String(v);
  return s.length ? s : null;
}

export async function readWorkbook(data: ArrayBuffer | Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  const buf = data instanceof ArrayBuffer ? Buffer.from(data) : data;
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

/**
 * 첫 번째 (또는 지정한) 시트를 헤더 기준 테이블로 읽는다.
 * 헤더는 값이 하나라도 있는 첫 행으로 잡는다.
 */
export function readSheet(wb: ExcelJS.Workbook, sheetName?: string): SheetTable {
  const ws = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
  if (!ws) throw new Error(`시트를 찾을 수 없습니다${sheetName ? `: ${sheetName}` : ""}`);

  let headerRowNo = 0;
  let headers: string[] = [];

  for (let i = 1; i <= ws.rowCount; i++) {
    const values = ws.getRow(i).values as unknown[];
    const cells = Array.isArray(values) ? values.slice(1).map(toCell) : [];
    if (cells.some((c) => c !== null && String(c).trim() !== "")) {
      headerRowNo = i;
      headers = cells.map((c, idx) => {
        const name = c === null ? "" : String(c).normalize("NFC").trim();
        return name || `__col${idx + 1}`;
      });
      break;
    }
  }

  if (!headerRowNo) {
    return { sheetName: ws.name, headers: [], rows: [], rowNos: [] };
  }

  const rows: Record<string, Cell>[] = [];
  const rowNos: number[] = [];

  for (let i = headerRowNo + 1; i <= ws.rowCount; i++) {
    const values = ws.getRow(i).values as unknown[];
    const cells = Array.isArray(values) ? values.slice(1).map(toCell) : [];
    if (!cells.some((c) => c !== null && String(c).trim() !== "")) continue;

    const rec: Record<string, Cell> = {};
    headers.forEach((h, idx) => {
      rec[h] = cells[idx] ?? null;
    });
    rows.push(rec);
    rowNos.push(i);
  }

  return { sheetName: ws.name, headers, rows, rowNos };
}

// ─────────────────────────────────────────────────────────────
// 셀 값 접근 헬퍼
// ─────────────────────────────────────────────────────────────

export function str(v: Cell): string | null {
  if (v === null) return null;
  const s = String(v).normalize("NFC").trim();
  return s.length ? s : null;
}

export function num(v: Cell): number | null {
  if (v === null) return null;
  if (typeof v === "number") return v;
  const n = Number(String(v).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** `1톤` `3.5톤` `10톤` → 1 / 3.5 / 10 */
export function tonnageOf(label: string | null): number | null {
  if (!label) return null;
  const m = /(\d+(?:\.\d+)?)/.exec(label);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}
