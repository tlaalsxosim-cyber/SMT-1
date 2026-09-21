/**
 * R-10 차량 톤수 제한 추출 — 표현이 "이하"로 통일되어 있지 않다 (2026-09-21 확장)
 *
 * 현업 확인: "2.5톤은 2.5톤 이하로 배차하라는 요청" — 접미사와 무관하게
 * 납품처명/비고(건)에 적힌 숫자+"톤"은 전부 그 톤수가 상한이라는 뜻이다.
 */
import { describe, expect, it } from "vitest";

import { extractTonnageLimit } from "@/lib/structure/delivery-name";

describe("extractTonnageLimit", () => {
  it("기존 패턴 — N톤이하 (이슬푸드)", () => {
    expect(extractTonnageLimit("13시전(3.5톤이하)")).toBe(3.5);
  });

  it("N톤까지 (수일푸드)", () => {
    expect(extractTonnageLimit("8~14시전/3.5톤까지")).toBe(3.5);
  });

  it("N톤배차 (달인식자재)", () => {
    expect(extractTonnageLimit("10시~12시,1시~2시(1톤배차)")).toBe(1);
  });

  it("접미사 없는 단독 표기 N톤 (문전대박푸드) — 2.5톤은 2.5톤 이하 요청", () => {
    expect(extractTonnageLimit("오전11~1시/2.5톤")).toBe(2.5);
  });

  it("비고(건)에 적힌 경우도 잡는다 (티비비씨) — 뒤에 다른 톤수 언급이 있어도 첫 값을 쓴다", () => {
    expect(
      extractTonnageLimit(
        "",
        "ok/30박스/3.5톤까지/1톤입고시파렛트2장깔고적재요청(010.9727.4157)/오전배송"
      )
    ).toBe(3.5);
  });

  it("톤수 언급이 없으면 null", () => {
    expect(extractTonnageLimit("오전9-11:30or오후14~16시")).toBeNull();
  });

  it("소스가 비어 있으면 null", () => {
    expect(extractTonnageLimit(null, undefined, "")).toBeNull();
  });
});
