"use client";

/**
 * 드래그 중 화면 가장자리 자동 스크롤 (2026-09-21 피드백)
 *
 * 기타(미배차) 목록이 길면 드래그할 항목이 화면 아래쪽에, 드롭할 기사 티켓이
 * 위쪽에 있어 동시에 보이지 않는 경우가 생긴다. 브라우저 네이티브 HTML5
 * 드래그는 `dragover`를 스펙상 최소 350ms마다 계속 쏴 주므로(마우스가 안
 * 움직여도), 이걸 받아서 포인터가 가장자리 근처에 있으면 스크롤한다.
 *
 * 포인터 아래 가장 가까운 스크롤 가능한 조상(기사 티켓 목록의
 * `xl:overflow-auto` 같은)이 있으면 그걸 스크롤하고, 없으면 창 자체를
 * 스크롤한다 — 기타(미배차) 목록은 별도 스크롤 박스가 아니라 페이지 흐름을
 * 그대로 타므로 이 경로로 빠진다.
 */

export const AUTOSCROLL_EDGE_PX = 72;
export const AUTOSCROLL_MAX_SPEED = 24;

/** 포인터 위치와 스크롤 영역 경계로 스크롤량을 계산한다. 0이면 스크롤 없음 */
export function computeAutoScrollDelta(
  pointerY: number,
  areaTop: number,
  areaBottom: number,
  edgePx: number = AUTOSCROLL_EDGE_PX,
  maxSpeed: number = AUTOSCROLL_MAX_SPEED
): number {
  const distFromTop = pointerY - areaTop;
  if (distFromTop >= 0 && distFromTop < edgePx) {
    return -maxSpeed * (1 - distFromTop / edgePx);
  }
  const distFromBottom = areaBottom - pointerY;
  if (distFromBottom >= 0 && distFromBottom < edgePx) {
    return maxSpeed * (1 - distFromBottom / edgePx);
  }
  return 0;
}

/** `el`에서 위로 올라가며 세로 스크롤이 실제로 가능한 첫 조상을 찾는다 */
export function findScrollableAncestor(el: Element | null): HTMLElement | null {
  let node: Element | null = el;
  while (node && node !== document.documentElement) {
    if (node instanceof HTMLElement) {
      const overflowY = getComputedStyle(node).overflowY;
      const scrollableStyle = overflowY === "auto" || overflowY === "scroll";
      if (scrollableStyle && node.scrollHeight > node.clientHeight + 1) return node;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * 전역 `dragover` 리스너를 붙여 자동 스크롤을 켠다. 클린업 함수를 반환하므로
 * `useEffect`에서 그대로 반환하면 된다.
 */
export function installDragAutoScroll(target: EventTarget = window): () => void {
  const handleDragOver = (e: Event) => {
    const de = e as DragEvent;
    const hovered = document.elementFromPoint(de.clientX, de.clientY);
    const scrollable = findScrollableAncestor(hovered);

    if (scrollable) {
      const rect = scrollable.getBoundingClientRect();
      const dy = computeAutoScrollDelta(de.clientY, rect.top, rect.bottom);
      if (dy !== 0) scrollable.scrollTop += dy;
      return;
    }

    const dy = computeAutoScrollDelta(de.clientY, 0, window.innerHeight);
    if (dy !== 0) window.scrollBy(0, dy);
  };

  target.addEventListener("dragover", handleDragOver);
  return () => target.removeEventListener("dragover", handleDragOver);
}
