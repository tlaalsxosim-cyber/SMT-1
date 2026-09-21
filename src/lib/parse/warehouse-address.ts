/**
 * 출고 창고 주소지 마스터 (`출고 창고 주소지.xlsx`) — FR-54
 *
 * 출고등록현황의 출고장소코드(BA열)로 조인해 그 출고 지점의 실제 출고 주소를 찾는다.
 * 2026-09-21 기준 15개 출고장소 중 **주소가 등록된 곳은 평택(2800) 하나뿐**이다.
 *
 * 등록되지 않은 코드는 이 표에 넣지 않는다 — 없는 주소를 추측해서 넣으면 안 된다
 * (현업 요청: "등록된 내용만 반영, 안 된 건 미반영"). 담당자가 주소지 파일을
 * 갱신해서 다시 요청하면 이 표만 채우면 된다.
 */
import type { Issue } from "@/lib/domain/types";

export const WAREHOUSE_ADDRESS_BY_SITE_CODE: Record<string, { name: string; address: string }> = {
  "2800": { name: "평택창고(수도권)", address: "평택시 유천로 49" },
};

export interface OriginDerivation {
  /** 등록된 주소로 확정됐으면 그 주소, 아니면 null(=기본 센터 주소 유지) */
  address: string | null;
  issues: Issue[];
}

/**
 * 배송지 목록의 출고장소코드를 모아 출발지 주소를 판단한다.
 *
 *  - 출고장소코드가 없는 파일(구 양식)이면 아무 것도 하지 않는다.
 *  - 등록된 주소가 정확히 하나로 좁혀지면 그 주소를 반환한다.
 *  - 등록된 주소가 둘 이상으로 갈리면(여러 창고에서 출고) 지금 구조는 출발지를
 *    하나만 지원하므로 자동 반영을 포기하고 경고로 알린다 — 기본 센터 주소를 그대로 쓴다.
 *  - 미등록 코드가 섞여 있으면 정보성 안내만 남기고 배차는 그대로 진행한다.
 */
export function deriveShipmentOrigin(
  points: { 출고장소코드?: string | null }[],
  registry: Record<string, { name: string; address: string }> = WAREHOUSE_ADDRESS_BY_SITE_CODE
): OriginDerivation {
  const issues: OriginDerivation["issues"] = [];
  const codes = [...new Set(points.map((p) => p.출고장소코드).filter((c): c is string => !!c))];

  if (codes.length === 0) return { address: null, issues };

  const registered = codes
    .map((c) => ({ code: c, entry: registry[c] }))
    .filter((x): x is { code: string; entry: { name: string; address: string } } => !!x.entry);

  const unregistered = codes.filter((c) => !registry[c]);
  if (unregistered.length > 0) {
    issues.push({
      level: "info",
      code: "FR-54",
      message: `출고장소 ${unregistered.length}곳은 주소가 아직 등록되지 않아 기본 센터 주소를 그대로 적용합니다`,
      detail: unregistered.join(", "),
    });
  }

  const distinctAddresses = [...new Set(registered.map((r) => r.entry.address))];

  if (distinctAddresses.length > 1) {
    issues.push({
      level: "warning",
      code: "FR-54",
      message:
        "등록된 출고장소 주소가 둘 이상으로 갈려 자동 반영을 하지 않았습니다 — 기본 센터 주소를 그대로 씁니다 (다중 출발지는 아직 지원하지 않습니다)",
      detail: registered.map((r) => `${r.entry.name}(${r.code}): ${r.entry.address}`).join(" / "),
    });
    return { address: null, issues };
  }

  if (distinctAddresses.length === 1) {
    return { address: distinctAddresses[0], issues };
  }

  return { address: null, issues };
}
