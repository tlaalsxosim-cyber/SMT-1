/**
 * TMAP jsv2 준비 판정 회귀 테스트
 *
 * 실제 버그: `window.Tmapv2`가 올라온 직후 지도를 만들었더니
 * `T.LatLng is not a constructor`로 터졌다. jsv2는 스크립트 onload 이후에도
 * 네임스페이스를 비동기로 채우므로, **필요한 생성자가 전부 함수일 때만**
 * 준비된 것으로 봐야 한다.
 */
import { describe, expect, it } from "vitest";

import { isTmapReady, scriptSrcsFromMarkup } from "@/components/tmap-sdk";

const ctor = () => function Fake() {};

/** 실제로 쓰는 생성자 전부 */
function fullNamespace(): Record<string, unknown> {
  return {
    Map: ctor(),
    LatLng: ctor(),
    LatLngBounds: ctor(),
    Marker: ctor(),
    Polyline: ctor(),
    InfoWindow: ctor(),
    Size: ctor(),
  };
}

describe("isTmapReady", () => {
  it("필요한 생성자가 전부 있으면 준비된 것으로 본다", () => {
    expect(isTmapReady(fullNamespace())).toBe(true);
  });

  it("SDK가 추가 멤버를 더 갖고 있어도 준비된 것으로 본다", () => {
    expect(isTmapReady({ ...fullNamespace(), Point: ctor(), extras: 1 })).toBe(true);
  });

  it.each(["Map", "LatLng", "LatLngBounds", "Marker", "Polyline", "InfoWindow", "Size"])(
    "%s가 아직 없으면 준비되지 않은 것으로 본다",
    (missing) => {
      const ns = fullNamespace();
      delete ns[missing];
      expect(isTmapReady(ns)).toBe(false);
    }
  );

  it("멤버가 함수가 아니면 준비되지 않은 것으로 본다 — 실제 버그 재현", () => {
    // 로딩 중간 상태: 네임스페이스 객체는 있지만 LatLng이 아직 생성자가 아니다
    const partial = { ...fullNamespace(), LatLng: undefined };
    expect(isTmapReady(partial)).toBe(false);

    const placeholder = { ...fullNamespace(), LatLng: {} };
    expect(isTmapReady(placeholder)).toBe(false);
  });

  it("빈 객체·null·원시값은 준비되지 않은 것으로 본다", () => {
    expect(isTmapReady({})).toBe(false);
    expect(isTmapReady(null)).toBe(false);
    expect(isTmapReady(undefined)).toBe(false);
    expect(isTmapReady("Tmapv2")).toBe(false);
  });
});

/**
 * 실제 버그: jsv2 부트스트랩이 SDK 본체를 `document.write`로 끼워 넣는데,
 * 문서 파싱이 끝난 뒤 동적으로 붙인 스크립트의 `document.write`는 브라우저가 무시한다.
 * 그래서 본체가 영영 안 올라오고 지도는 늘 SVG 폴백으로 떨어졌다.
 * 가로챈 마크업에서 본체 주소를 뽑아내는 부분을 고정한다.
 */
describe("scriptSrcsFromMarkup", () => {
  it("부트스트랩이 실제로 쓰는 마크업에서 본체 주소를 뽑는다", () => {
    // jsv2 부트스트랩이 만들어 내는 문자열 그대로 (작은따옴표 속성)
    const written =
      "<script src='https://topopentile1.tmap.co.kr/scriptSDKV2/tmapjs2.min.js?version=20231206'></script>";
    expect(scriptSrcsFromMarkup(written)).toEqual([
      "https://topopentile1.tmap.co.kr/scriptSDKV2/tmapjs2.min.js?version=20231206",
    ]);
  });

  it("여러 개를 한 번에 써도 순서대로 뽑는다", () => {
    const written =
      "<script src='https://x/a.js'></script><script src=\"https://x/b.js\"></script>";
    expect(scriptSrcsFromMarkup(written)).toEqual(["https://x/a.js", "https://x/b.js"]);
  });

  it("따옴표 없는 속성·대문자 태그도 읽는다", () => {
    expect(scriptSrcsFromMarkup("<SCRIPT SRC=https://x/c.js></SCRIPT>")).toEqual([
      "https://x/c.js",
    ]);
  });

  it("src 없는 인라인 스크립트는 건너뛴다", () => {
    expect(scriptSrcsFromMarkup("<script>var a=1;</script>")).toEqual([]);
    expect(scriptSrcsFromMarkup("")).toEqual([]);
  });

  it("src처럼 생긴 다른 속성에 속지 않는다", () => {
    expect(scriptSrcsFromMarkup("<script data-src='https://x/no.js'></script>")).toEqual([]);
  });
});
