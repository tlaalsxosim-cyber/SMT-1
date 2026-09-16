import { describe, expect, it } from "vitest";
import {
  formatWindows,
  isWithin,
  parseTimeText,
  subtractExclusions,
  validateWindows,
} from "@/lib/structure/time-window";
import { resolveTime } from "@/lib/structure/merge";

const fmt = (raw: string) => formatWindows(parseTimeText(raw).windows);

describe("납품시간 컬럼 형식", () => {
  it.each([
    ["~13:00", "08:00~13:00"],
    ["~13:30", "08:00~13:30"],
    ["8:00~14:00", "08:00~14:00"],
    ["8:30~13:00", "08:30~13:00"],
    ["9:30~15:00", "09:30~15:00"],
    ["11:30~14:00", "11:30~14:00"],
    ["8:00~16:00", "08:00~16:00"],
  ])("%s → %s", (raw, expected) => {
    expect(fmt(raw)).toBe(expected);
  });
});

describe("납품처명 조건 — 마감 표현", () => {
  it.each([
    ["13시30분전", "08:00~13:30"],
    ["13시착", "08:00~13:00"],
    ["12시전", "08:00~12:00"],
    ["오전12시전", "08:00~12:00"],
    ["오전11시전", "08:00~11:00"],
    ["오전10시까지", "08:00~10:00"],
    ["오후3시전", "08:00~15:00"],
    ["오후3시이전", "08:00~15:00"],
    ["오전11시", "08:00~11:00"],
    ["10시", "08:00~10:00"],
    ["11시전(이후퇴근)", "08:00~11:00"],
  ])("%s → %s", (raw, expected) => {
    expect(fmt(raw)).toBe(expected);
  });

  it("오후 축약 시각을 24시간제로 해석한다 (2시전 → 14:00)", () => {
    expect(fmt("2시전")).toBe("08:00~14:00");
    expect(fmt("오후2:30분전")).toBe("08:00~14:30");
  });

  it("숫자 없는 오전/오후 표현을 처리한다", () => {
    expect(fmt("오전")).toBe("08:00~12:00");
  });
});

describe("납품처명 조건 — 범위 표현", () => {
  it.each([
    ["9시~14시", "09:00~14:00"],
    ["8~16시", "08:00~16:00"],
    ["8-15시", "08:00~15:00"],
    ["8:30-13:00", "08:30~13:00"],
    ["8~10시전", "08:00~10:00"],
    ["11시~12시", "11:00~12:00"],
  ])("%s → %s", (raw, expected) => {
    expect(fmt(raw)).toBe(expected);
  });

  it("종료 시각이 시작보다 작으면 오후로 해석한다", () => {
    // 씨에스상사: 오전11:30~2(도착30분전 전화)
    expect(fmt("오전11:30~2(도착30분전 전화)")).toBe("11:30~14:00");
  });
});

describe("배제 구간 분리 (R-14 / FR-12)", () => {
  it("점심 구간을 빼 시간창 2개로 나눈다", () => {
    // 수원2센터
    expect(fmt("8~14시 (점심12-13시)")).toBe("08:00~12:00, 13:00~14:00");
    // 씨제이프레시원강남
    expect(fmt("8:30~14시(11:30~13시점심)")).toBe("08:30~11:30, 13:00~14:00");
    // 자연이랑
    expect(fmt("9:30~15시(12~13시점심)")).toBe("09:30~12:00, 13:00~15:00");
    // 마린
    expect(fmt("9~16시(점심13~14)")).toBe("09:00~13:00, 14:00~16:00");
    // 소백산유통
    expect(fmt("9~16시전(점심12~13)")).toBe("09:00~12:00, 13:00~16:00");
  });

  it("제외/X 표기도 배제 구간으로 인식한다", () => {
    // 지케이 광주새말길 — AC-05
    expect(fmt("8~15시(12시30분~13시30분제외)")).toBe("08:00~12:30, 13:30~15:00");
    // 다인푸드시스템 — 1:30을 13:30으로 해석
    expect(fmt("9~14시(12~1:30X)")).toBe("09:00~12:00, 13:30~14:00");
  });

  it("분리 표기(또는 / OR / &)를 시간창 2개로 만든다", () => {
    // 채움푸드 — AC-06
    expect(fmt("8~11또는13~14:30(점심11:30~13)")).toBe("08:00~11:00, 13:00~14:30");
    // 삼성웰스토리
    expect(fmt("8~10:30OR12~13:30/배송전연락")).toBe("08:00~10:30, 12:00~13:30");
    // 링커
    expect(fmt("9~11:30&13~15")).toBe("09:00~11:30, 13:00~15:00");
  });

  it("배제 구간만 주어지면 운영 시간을 가정하고 플래그를 세운다", () => {
    // 원앤원
    const r = parseTimeText("점심11~12시30분");
    expect(r.assumedOperating).toBe(true);
    expect(formatWindows(r.windows)).toBe("08:00~11:00, 12:30~18:00");
  });
});

describe("시간 정보가 없는 조건 텍스트", () => {
  it.each(["창고안적재(비대면)", "", "안전화필히착용", "리얼후라이드진천제품으로만"])(
    "%s → 시간창 없음",
    (raw) => {
      expect(parseTimeText(raw).windows).toHaveLength(0);
    }
  );
});

describe("추가 토큰이 붙어도 시간만 뽑아낸다", () => {
  it("5토큰 납품처명의 조건부", () => {
    expect(fmt("9시~14시/안전화필히착용")).toBe("09:00~14:00");
    expect(fmt("13시전/리얼후라이드진천제품으로만")).toBe("08:00~13:00");
    expect(fmt("13시전(3.5톤이하)")).toBe("08:00~13:00");
  });
});

describe("납품 시작 시각 (R-16)", () => {
  it("시작 시각이 등록된 업체는 등록값을 그대로 쓴다", () => {
    for (const [raw, expected] of [
      ["8:30~13:00", "08:30~13:00"],
      ["9:00~14:00", "09:00~14:00"],
      ["9:30~15:00", "09:30~15:00"],
      ["11:00~12:00", "11:00~12:00"],
      ["11:30~14:00", "11:30~14:00"],
      ["8~10:30OR12~13:30", "08:00~10:30, 12:00~13:30"],
    ] as const) {
      const r = parseTimeText(raw);
      expect(r.explicitStart, raw).toBe(true);
      expect(formatWindows(r.windows), raw).toBe(expected);
    }
  });

  it("08:00보다 이른 등록값도 08:00으로 올리지 않는다", () => {
    const r = parseTimeText("6:30~11:00");
    expect(r.explicitStart).toBe(true);
    expect(formatWindows(r.windows)).toBe("06:30~11:00");
  });

  it("시작 시각이 누락된 업체만 08:00으로 채운다", () => {
    for (const raw of ["~13:00", "13시착", "12시전", "오전", "오후2:30분전"]) {
      const r = parseTimeText(raw);
      expect(r.explicitStart, raw).toBe(false);
      expect(Math.min(...r.windows.map((w) => w.start)), raw).toBe(8 * 60);
    }
  });

  it("등록된 시작 + 배제 구간이면 등록 시작을 유지한 채로 나눈다", () => {
    const r = parseTimeText("9~16시(점심13~14)");
    expect(r.explicitStart).toBe(true);
    expect(formatWindows(r.windows)).toBe("09:00~13:00, 14:00~16:00");
  });

  it("두 소스 중 한쪽만 시작을 등록해도 등록으로 본다", () => {
    // 삼성웰스토리 — 컬럼은 비었고 납품처명에만 8~10:30이 있다
    const r = resolveTime(null, "8~10:30OR12~13:30/배송전연락");
    expect(r.hasExplicitStart).toBe(true);
    expect(formatWindows(r.windows)).toBe("08:00~10:30, 12:00~13:30");
  });

  it("마감이 08:00 이전이면 시작을 채우지 않는다 (비정상 값 보호)", () => {
    // `7시전`은 "8시 미만 단독 시각은 오후" 규칙에 따라 19:00으로 읽히므로,
    // 오전임이 명시된 표현으로 확인한다.
    const r = parseTimeText("오전7시전");
    expect(formatWindows(r.windows)).toBe("~07:00");
  });

  it("8시 미만 단독 마감은 오후로 해석한 뒤 08:00을 채운다", () => {
    expect(formatWindows(parseTimeText("7시전").windows)).toBe("08:00~19:00");
    expect(formatWindows(parseTimeText("2시전").windows)).toBe("08:00~14:00");
  });
});

describe("두 소스 대조·병합 (FR-11)", () => {
  it("경계가 어긋나면 엄격한 쪽을 채택하고 conflict를 세운다", () => {
    // 지케이 광주새말길 — AC-05
    const r = resolveTime("8:00~17:00", "8~15시(12시30분~13시30분제외)");
    expect(r.mismatch).toBe("boundary");
    expect(r.conflict).toBe(true);
    expect(r.adopted).toBe("name");
    expect(formatWindows(r.windows)).toBe("08:00~12:30, 13:30~15:00");
  });

  it("동원홈푸드(화성센터) — 컬럼 마감이 1시간 과대", () => {
    const r = resolveTime("8:30~14:00", "8:30~13:00");
    expect(r.mismatch).toBe("boundary");
    expect(formatWindows(r.windows)).toBe("08:30~13:00");
  });

  it("컬럼이 비면 납품처명에서 회수한다", () => {
    const r = resolveTime(null, "12시전");
    expect(r.mismatch).toBe("missing");
    expect(r.adopted).toBe("name");
    expect(formatWindows(r.windows)).toBe("08:00~12:00");
  });

  it("경계가 같고 내부만 세분화되면 refine으로 분류한다", () => {
    // 채움푸드 — 컬럼 8:00~14:30, 원문은 점심 배제
    const r = resolveTime("8:00~14:30", "8~11또는13~14:30(점심11:30~13)");
    expect(r.mismatch).toBe("refine");
    expect(r.conflict).toBe(false);
    expect(formatWindows(r.windows)).toBe("08:00~11:00, 13:00~14:30");
  });

  it("양쪽이 같으면 일치로 본다", () => {
    const r = resolveTime("8:30~13:00", "8:30-13:00");
    expect(r.mismatch).toBe("none");
    expect(r.adopted).toBe("both");
  });

  it("양쪽 모두 비면 무제약", () => {
    const r = resolveTime(null, "창고안적재(비대면)");
    expect(r.windows).toHaveLength(0);
    expect(r.adopted).toBe("none");
  });
});

describe("유틸", () => {
  it("배제 구간 차감", () => {
    expect(
      subtractExclusions([{ start: 480, end: 900 }], [{ start: 720, end: 780 }])
    ).toEqual([
      { start: 480, end: 720 },
      { start: 780, end: 900 },
    ]);
  });

  it("형식 검증 (FR-17)", () => {
    expect(validateWindows([{ start: 480, end: 900 }])).toBeNull();
    expect(validateWindows([{ start: 900, end: 480 }])).not.toBeNull();
    expect(validateWindows([{ start: -10, end: 480 }])).not.toBeNull();
    expect(validateWindows([{ start: 0, end: 1500 }])).not.toBeNull();
  });

  it("시간창이 없으면 무제약으로 본다", () => {
    expect(isWithin([], 600)).toBe(true);
    expect(isWithin([{ start: 480, end: 660 }], 600)).toBe(true);
    expect(isWithin([{ start: 480, end: 660 }], 700)).toBe(false);
  });
});
