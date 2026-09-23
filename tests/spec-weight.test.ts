/**
 * R-21 규격 중량 추출 — 중량 기준 우선 분류(미배차·일성)의 판정 기초
 *
 * 규격란은 항상 맨 앞에 중량 토큰이 온다(2026-09-15 실데이터 304행 전량 확인).
 * "120KG"처럼 20이 중간에 낀 값을 20kg으로 오인하면 안 된다.
 */
import { describe, expect, it } from "vitest";

import { extractSpecWeightKg } from "@/lib/structure/delivery-name";

describe("extractSpecWeightKg", () => {
  it("맨 앞 중량 토큰을 읽는다 (동우참프레 실데이터)", () => {
    expect(extractSpecWeightKg("20KG (10KG*2BAG)")).toBe(20);
  });

  it("복합 표기에서도 맨 앞 값만 읽는다", () => {
    expect(extractSpecWeightKg("10KG(1KG*10BAGS)/BOX_8809146313362")).toBe(10);
  });

  it("소수점 중량도 읽는다", () => {
    expect(extractSpecWeightKg("8.832KG(...)")).toBe(8.832);
  });

  it("120KG을 20kg으로 오인하지 않는다", () => {
    expect(extractSpecWeightKg("120KG(...)")).toBe(120);
  });

  it("대소문자를 가리지 않는다", () => {
    expect(extractSpecWeightKg("20kg (10kg*2bag)")).toBe(20);
  });

  it("중량 토큰이 맨 앞에 없으면 null", () => {
    expect(extractSpecWeightKg("BOX(20KG)")).toBeNull();
  });

  it("빈 값이면 null", () => {
    expect(extractSpecWeightKg(null)).toBeNull();
    expect(extractSpecWeightKg(undefined)).toBeNull();
    expect(extractSpecWeightKg("")).toBeNull();
  });
});
