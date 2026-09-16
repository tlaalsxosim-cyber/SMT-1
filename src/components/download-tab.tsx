"use client";

/**
 * ③ 결과 다운로드 (§11 ③ / FR-50 ~ FR-53)
 *
 * 다운로드한 엑셀이 **보관·공유·수정의 기준 문서**다.
 * 다운로드 전 이탈 시 결과가 사라진다는 점을 분명히 안내한다 (FR-51).
 */

import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Info } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { formatDate, n, pct } from "@/lib/format";
import { useApp } from "@/lib/store";

const SHEETS = [
  {
    name: "배차표",
    detail:
      "기사 / 톤수 / 회전 / 방문순서 / 업체명 / 권역 / 주소 / 박스 / 납품시간(원문·해석) / TMAP 도착예정 / 시간창 충족 / 특이사항 태그 / 연락처 + 회전별 적재율·주행거리·귀가거리 소계",
  },
  {
    name: "기타_미배차",
    detail: "권역별로 묶고 소계를 붙인 미배차 목록 — 사유 코드 포함. 용차 판단용",
  },
  {
    name: "주소확인필요",
    detail: "지오코딩 실패·도로명 불일치 주소와 AI 정제 제안 — 원본 파일 수정용",
  },
  {
    name: "요약",
    detail: "입력 지표 / 차량 가용 능력 / 배차 결과 / 제약 위반 / API 호출 건수 / AI 브리핑",
  },
  {
    name: "검증이슈",
    detail: "담당자 확인 목록 전체 — 수준·코드·대상·내용·상세",
  },
] as const;

export function DownloadTab() {
  const { result, downloadResult, downloaded, settings, updateSettings } = useApp();

  if (!result) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <FileSpreadsheet className="size-10 text-muted-foreground" />
          <div className="text-lg font-medium">다운로드할 결과가 없습니다</div>
          <p className="max-w-md text-sm text-muted-foreground">
            배차를 먼저 실행하십시오. 결과는 서버에 저장되지 않으므로 실행할 때마다 새로 만들어집니다.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {downloaded ? (
        <Alert className="border-emerald-500/40 bg-emerald-500/5">
          <CheckCircle2 className="text-emerald-600" />
          <AlertTitle>다운로드 완료</AlertTitle>
          <AlertDescription>
            이 엑셀이 공식 산출물입니다. 이후 보관·공유·수정은 이 파일을 기준으로 하십시오.
          </AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <AlertTriangle className="text-amber-600" />
          <AlertTitle>아직 내려받지 않았습니다</AlertTitle>
          <AlertDescription>
            데이터베이스를 쓰지 않는 구조라, 다운로드 전에 페이지를 벗어나거나 새로고침하면
            결과가 사라지고 배차를 다시 실행해야 합니다.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">결과 엑셀</CardTitle>
          <CardDescription>
            {formatDate(result.date)} · 배차 {n(result.assignedBoxes)}박스 (
            {pct(result.assignedBoxes / Math.max(1, result.totalBoxes), 1)}) · 기타{" "}
            {n(result.unassignedBoxes)}박스 · {result.usedTrips}회전
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            {SHEETS.map((s, i) => (
              <div key={s.name} className="flex gap-3 rounded-md border p-3">
                <Badge variant="secondary" className="h-6 shrink-0">
                  {i + 1}
                </Badge>
                <div className="min-w-0">
                  <div className="text-sm font-medium">{s.name}</div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{s.detail}</p>
                </div>
              </div>
            ))}

            <div className="flex items-start justify-between gap-4 rounded-md border border-dashed p-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="h-6 shrink-0">
                    6
                  </Badge>
                  <span className="text-sm font-medium">좌표 (선택)</span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  납품처·기사 도착지 좌표. TMAP 약관상 경로 좌표는 24시간 이상 저장·재사용이
                  금지되므로, 재사용 가능 범위를 운영 전 확인해야 합니다 (OI-5).
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Label htmlFor="coord-toggle" className="text-xs">
                  포함
                </Label>
                <Switch
                  id="coord-toggle"
                  checked={settings.includeCoordinates}
                  onCheckedChange={(includeCoordinates) => updateSettings({ includeCoordinates })}
                />
              </div>
            </div>
          </div>

          <Button size="lg" className="w-full" onClick={() => void downloadResult()}>
            <Download /> 배차결과_{result.date}.xlsx 다운로드
          </Button>

          <Alert>
            <Info />
            <AlertDescription className="text-xs">
              다운로드와 함께 이 세션의 데이터는 그대로 메모리에만 남습니다. 서버에는 업로드 파일도,
              좌표도, 경로도 저장되지 않습니다 (NFR-01 · NFR-02).
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </div>
  );
}
