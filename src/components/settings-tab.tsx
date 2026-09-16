"use client";

/**
 * ④ 설정 (§11 ④ / FR-32, FR-34, NFR-01, NFR-03)
 *
 * 설정은 **저장하지 않는다**. 매 실행 기본값에서 시작하며 세션 한정으로만 바뀐다.
 * 키는 존재 여부만 표시하고 값은 절대 화면에 내보내지 않는다.
 */

import { useEffect } from "react";
import { AlertTriangle, CheckCircle2, Info, KeyRound, RefreshCw, XCircle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import {
  CENTER,
  EARLY_DELIVERY_RULES,
  LARGE_VEHICLE_TONNAGE,
  METRO_SOUTH_LIMIT_LAT,
  OPTIMIZE_SAFE_CAP,
  SECOND_TRIP_MIN_DEADLINE,
} from "@/lib/domain/constants";
import { hhmm, minutesFromHHMM, n } from "@/lib/format";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

export function SettingsTab() {
  const { settings, updateSettings, status, refreshStatus } = useApp();

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* 실행 옵션 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">실행 옵션</CardTitle>
          <CardDescription>
            저장하지 않습니다. 새로고침하면 기본값으로 돌아갑니다 (NFR-01).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <ToggleRow
            id="demo"
            label="Demo Mode"
            description="TMAP을 전혀 호출하지 않고 근사 좌표·2-opt 순서로 전 과정을 재현합니다. 경유지 최적화 무료 한도(50건/일)를 지키기 위한 보호 장치입니다."
            checked={settings.demo}
            onChange={(demo) => updateSettings({ demo })}
          />

          <ToggleRow
            id="ai"
            label="생성형 AI 조건 구조화"
            description="규칙 파서가 해석하지 못했거나 두 소스가 어긋난 건만 AI에 보냅니다. AI 출력은 규칙 검증을 통과해야 배차에 반영됩니다 (FR-16)."
            checked={settings.useAi}
            onChange={(useAi) => updateSettings({ useAi })}
            disabled={!status?.anthropicKeyPresent}
            disabledNote={
              status && !status.anthropicKeyPresent
                ? "ANTHROPIC_API_KEY가 설정되지 않았습니다"
                : undefined
            }
          />

          <ToggleRow
            id="routes"
            label="실도로 경로선 계산"
            description="다중 경유지 API로 회전별 경로선과 구간 시간을 산출합니다. 끄면 호출을 절약합니다."
            checked={settings.drawRoutes}
            onChange={(drawRoutes) => updateSettings({ drawRoutes })}
          />

          <ToggleRow
            id="coords"
            label="결과 엑셀에 좌표 시트 포함"
            description="TMAP 약관상 경로 좌표의 24시간 초과 보관 가능 여부를 운영 전 확인해야 합니다 (OI-5). 기본 비활성입니다."
            checked={settings.includeCoordinates}
            onChange={(includeCoordinates) => updateSettings({ includeCoordinates })}
          />

          <div className="space-y-2">
            <Label htmlFor="departAt">센터 출발 시각</Label>
            <Input
              id="departAt"
              type="time"
              value={hhmm(settings.departAt)}
              onChange={(e) => {
                const m = minutesFromHHMM(e.target.value);
                if (m !== null) updateSettings({ departAt: m });
              }}
              className="w-40"
            />
            <p className="text-xs text-muted-foreground">
              조기납품 업체는 8시대 도착을 요구합니다. 기본값 06:00은 잠정치이며 확정이 필요합니다 (OI-7).
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="center">센터 주소</Label>
            <Input
              id="center"
              placeholder={CENTER.address}
              value={settings.centerAddress}
              onChange={(e) => updateSettings({ centerAddress: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              비워 두면 기본값 「{CENTER.address}」을 사용합니다.
            </p>
          </div>

          <div className="space-y-2">
            <Label>조기납품 판정 기준 (R-08)</Label>
            <div className="grid gap-2">
              {(Object.keys(EARLY_DELIVERY_RULES) as (keyof typeof EARLY_DELIVERY_RULES)[]).map(
                (key) => {
                  const rule = EARLY_DELIVERY_RULES[key];
                  const active = settings.earlyMode === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => updateSettings({ earlyMode: key })}
                      className={cn(
                        "rounded-md border px-3 py-2 text-left text-sm transition-colors",
                        active ? "border-primary bg-primary/5" : "hover:bg-accent/50"
                      )}
                    >
                      <div className="flex items-center gap-2 font-medium">
                        {rule.label}
                        {active && <Badge variant="secondary" className="text-[10px]">선택됨</Badge>}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">{rule.describe}</div>
                    </button>
                  );
                }
              )}
            </div>
            <Alert>
              <AlertTriangle className="text-amber-600" />
              <AlertTitle>기준값 미확정 (OI-2)</AlertTitle>
              <AlertDescription className="text-xs">
                제약은 <strong>한 기사에게 조기납품 업체를 2곳 이상 배정하지 않는 것</strong>이며,
                회전 번호 제약은 없습니다. 기사가 9명이므로 조기납품 업체가 9곳을 넘으면 초과분은
                반드시 기타로 빠집니다. 2026-09-15 실데이터 기준 「마감 ≤ 09:00」은 0곳이라 규칙이
                발동하지 않고, 「시작 ≤ 09:00」은 18곳이라 최소 9곳이 강제 미배차됩니다.
                현업 확인 전까지 중간값을 기본으로 둡니다.
              </AlertDescription>
            </Alert>
          </div>

          <div className="space-y-2">
            <Label>2회전 납품 마감 하한 (R-15)</Label>
            <div className="rounded-md border bg-muted/30 px-3 py-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                마감 {hhmm(SECOND_TRIP_MIN_DEADLINE)} 이후 업체만
                <Badge variant="secondary" className="text-[10px]">
                  확정 규칙
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                센터로 복귀해 재상차한 뒤 다시 나가는 회전은 실제 하차가 정오를 넘습니다.
                마감이 {hhmm(SECOND_TRIP_MIN_DEADLINE)}보다 이른 업체는 2회전에 배정하지 않습니다.
                1회전에는 적용되지 않고, 시간 제약이 없는 업체는 언제든 허용합니다.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                담당자가 바꾸는 설정이 아니라 확정된 업무 규칙이므로 화면에서 변경할 수 없습니다.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label>대형차 1업체 원칙 (R-17)</Label>
            <div className="rounded-md border bg-muted/30 px-3 py-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                {LARGE_VEHICLE_TONNAGE}톤 이상은 회전당 1업체
                <Badge variant="secondary" className="text-[10px]">
                  확정 규칙
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                2번째 업체는 첫 업체와 <strong>주소가 거의 동일할 때만</strong> 붙습니다
                (층·도크·건물명을 뺀 도로명/지번이 같을 때). 차량 마스터의 「최대업체수 2」는
                <em> 같은 건물에 업체가 둘일 때의 상한</em>이지 아무 두 곳이나 묶어도 된다는 뜻이
                아닙니다.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                적재 하한(R-03)과 맞물려 <strong>하한 미만의 소량 업체는 대형차에 배차되지
                않습니다</strong> — 10톤 차(하한 500박스)에 30박스짜리가 얹히던 문제를 막습니다.
                실을 회전이 없으면 사유 「대형차단독」으로 기타에 남습니다.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label>수도권 외 제외 (R-18)</Label>
            <div className="rounded-md border bg-muted/30 px-3 py-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                천안 이남(위도 {METRO_SOUTH_LIMIT_LAT})은 지입 배차 제외
                <Badge variant="secondary" className="text-[10px]">
                  확정 규칙
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                <strong>후순위가 아니라 제외</strong>입니다. 배차 대상에서 아예 빼고, 사유
                「수도권외」로 기타에 남겨 <strong>용차 판단으로 넘깁니다</strong>. 초과 물량
                분할(R-06)보다 먼저 적용하므로 남쪽 대형 건은 쪼개지 않고 한 줄로 남습니다.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                2026-09-15 실데이터에서 제외 대상은 천안·아산·청주·익산 4곳(2,514박스)입니다.
                R-17과 겹쳐 <strong>10톤 2대가 공차</strong>가 되며, 그 사실은 검증이슈에 경고로
                남습니다 — 수도권 최대 단일 업체가 474박스라 10톤 하한 500을 넘지 못합니다.
              </p>
            </div>
          </div>

          <Alert>
            <Info />
            <AlertTitle>납품 시작 시각이 누락된 업체만 08:00 적용</AlertTitle>
            <AlertDescription className="text-xs">
              <strong>시작 시각이 등록된 업체는 등록값을 그대로 씁니다</strong> — 「8:30~13:00」은
              08:30, 「9~16시」는 09:00으로 시작합니다. 「13시착」처럼 <strong>마감만 주어진 업체</strong>만
              08:00으로 채워 <code>08:00~13:00</code>으로 해석합니다.
              2026-09-15 실데이터 기준 등록 20곳 · 누락 25곳이며, <code>npm run start-check</code>로
              업체별 적용 결과를 확인할 수 있습니다.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {/* 키 상태 · API 카운터 */}
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <KeyRound className="size-4" /> 키 상태
                </CardTitle>
                <CardDescription>
                  환경변수로만 관리합니다. 값은 화면에 표시하지 않습니다 (NFR-03).
                </CardDescription>
              </div>
              <Button variant="outline" size="sm" onClick={() => void refreshStatus()}>
                <RefreshCw /> 새로고침
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            <KeyRow
              name="TMAP_APP_KEY"
              present={status?.tmapKeyPresent ?? false}
              note="지오코딩·경로안내·최적화 (서버 프록시 전용)"
            />
            <KeyRow
              name="NEXT_PUBLIC_TMAP_WEB_KEY"
              present={status?.mapKeyPresent ?? false}
              note="지도 SDK용 브라우저 키 — 운영 키와 분리하고 도메인 제한을 거십시오"
              optional
            />
            <KeyRow
              name="ANTHROPIC_API_KEY"
              present={status?.anthropicKeyPresent ?? false}
              note="조건 구조화 · 주소 정제 제안 · 브리핑"
              optional
            />

            {status && !status.tmapKeyPresent && (
              <Alert>
                <AlertTriangle className="text-amber-600" />
                <AlertTitle>TMAP 키가 없습니다</AlertTitle>
                <AlertDescription className="text-xs">
                  Demo Mode로만 실행할 수 있습니다. 프로젝트 루트에 <code>.env.local</code> 파일을
                  만들고 <code>TMAP_APP_KEY=발급받은키</code> 를 넣은 뒤 개발 서버를 다시 시작하십시오.
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">일일 API 호출 카운터 (FR-32)</CardTitle>
            <CardDescription>
              서버 프로세스 메모리에만 있습니다 — 재시작하면 0으로 돌아갑니다 (NFR-01).
              {status && ` 기준일 ${status.usage.date}`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {status ? (
              <>
                <UsageRow
                  label="경유지 최적화"
                  used={status.usage.counts.optimize}
                  limit={status.usage.limits.optimize}
                  emphasis
                  note={`안전 상한 ${OPTIMIZE_SAFE_CAP}건 (회전 12 + 재시도 12) · 잔여 ${status.usage.optimizeSafeRemaining}건`}
                />
                <UsageRow
                  label="지오코딩"
                  used={status.usage.counts.geocode}
                  limit={status.usage.limits.geocode}
                />
                <UsageRow
                  label="자동차 경로안내"
                  used={status.usage.counts.routes}
                  limit={status.usage.limits.routes}
                />
                <UsageRow
                  label="다중 경유지"
                  used={status.usage.counts.sequential}
                  limit={status.usage.limits.routes}
                  note="경로안내 한도 공유"
                />

                {status.usage.running && (
                  <Alert>
                    <AlertTriangle className="text-amber-600" />
                    <AlertTitle>배차 실행 중</AlertTitle>
                    <AlertDescription className="text-xs">
                      중복 실행이 서버에서 차단됩니다 (FR-33).
                    </AlertDescription>
                  </Alert>
                )}
              </>
            ) : (
              <div className="text-sm text-muted-foreground">상태를 불러오는 중…</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ToggleRow({
  id,
  label,
  description,
  checked,
  onChange,
  disabled,
  disabledNote,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  disabledNote?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <Label htmlFor={id} className="text-sm">
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{description}</p>
        {disabled && disabledNote && (
          <p className="text-xs text-amber-600 dark:text-amber-400">{disabledNote}</p>
        )}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

function KeyRow({
  name,
  present,
  note,
  optional,
}: {
  name: string;
  present: boolean;
  note: string;
  optional?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-md border px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <code className="text-xs font-medium">{name}</code>
          {optional && (
            <Badge variant="outline" className="text-[10px]">
              선택
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>
      </div>
      {present ? (
        <Badge className="shrink-0 gap-1 bg-emerald-600 hover:bg-emerald-600">
          <CheckCircle2 className="size-3" /> 설정됨
        </Badge>
      ) : (
        <Badge variant="outline" className="shrink-0 gap-1 text-muted-foreground">
          <XCircle className="size-3" /> 미설정
        </Badge>
      )}
    </div>
  );
}

function UsageRow({
  label,
  used,
  limit,
  note,
  emphasis,
}: {
  label: string;
  used: number;
  limit: number;
  note?: string;
  emphasis?: boolean;
}) {
  const ratio = limit > 0 ? used / limit : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className={cn("text-sm", emphasis && "font-semibold")}>{label}</span>
        <span className="text-sm tabular-nums text-muted-foreground">
          {n(used)} / {n(limit)}
        </span>
      </div>
      <Progress
        value={Math.min(100, ratio * 100)}
        className={cn("h-1.5", emphasis && ratio > 0.5 && "[&>div]:bg-amber-500")}
      />
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}
