/**
 * 드래그 중 자동 스크롤 — 순수 계산 로직만 단위 테스트한다.
 * DOM 스크롤 자체(installDragAutoScroll)는 tests/README에 기술한 계층 구분상
 * 브라우저 없는 vitest로는 의미 있게 고정하기 어려워, scripts/run 스킬로 확인한다.
 */
import { describe, expect, it } from "vitest";

import { computeAutoScrollDelta } from "@/lib/drag-autoscroll";

describe("computeAutoScrollDelta", () => {
  it("영역 중앙이면 스크롤하지 않는다", () => {
    expect(computeAutoScrollDelta(500, 0, 1000)).toBe(0);
  });

  it("위쪽 가장자리 안이면 음수(위로 스크롤)를 반환한다", () => {
    const d = computeAutoScrollDelta(10, 0, 1000, 72, 24);
    expect(d).toBeLessThan(0);
  });

  it("아래쪽 가장자리 안이면 양수(아래로 스크롤)를 반환한다", () => {
    const d = computeAutoScrollDelta(990, 0, 1000, 72, 24);
    expect(d).toBeGreaterThan(0);
  });

  it("가장자리에 딱 붙을수록 스크롤량이 커진다", () => {
    const near = computeAutoScrollDelta(999, 0, 1000, 72, 24);
    const far = computeAutoScrollDelta(950, 0, 1000, 72, 24);
    expect(Math.abs(near)).toBeGreaterThan(Math.abs(far));
  });

  it("영역 경계 밖(다른 컨테이너)이면 0이다", () => {
    expect(computeAutoScrollDelta(-10, 0, 1000)).toBe(0);
    expect(computeAutoScrollDelta(1010, 0, 1000)).toBe(0);
  });
});
