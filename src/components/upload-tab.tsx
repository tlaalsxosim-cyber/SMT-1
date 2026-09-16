"use client";

/**
 * ② 데이터 업로드 (§11 ② / FR-01 ~ FR-08, FR-18)
 *
 * 파일 2개를 함께 받고, 파싱 지표와 **원문 | 해석 | 검증** 3열 미리보기를 보여준다.
 * 차량 마스터는 읽기 전용이다 — 수정은 파일을 고쳐 다시 올리는 것이 기준이다.
 */

import { useCallback, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  Info,
  Loader2,
  Play,
  Upload,
  X,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ParseResponse, PreviewPoint } from "@/lib/api/contracts";
import { formatDate, n } from "@/lib/format";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

export function UploadTab() {
  const {
    shipmentFile,
    fleetFile,
    setShipmentFile,
    setFleetFile,
    preview,
    parsing,
    parseError,
    parseFiles,
    runDispatch,
    dispatching,
    settings,
  } = useApp();

  const ready = Boolean(shipmentFile && fleetFile);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        <DropZone
          title="출고등록현황.xlsx"
          description="일일 변동 — ERP에서 내려받은 원본"
          file={shipmentFile}
          onFile={setShipmentFile}
        />
        <DropZone
          title="차량_톤수.xlsx"
          description="기사 · 적재범위 · 회전수 · 도착지 (고정)"
          file={fleetFile}
          onFile={setFleetFile}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void parseFiles()} disabled={!ready || parsing} size="lg">
          {parsing ? <Loader2 className="animate-spin" /> : <FileSpreadsheet />}
          파일 검증 · 미리보기
        </Button>

        {preview && (
          <Button
            onClick={() => void runDispatch()}
            disabled={dispatching}
            size="lg"
            variant="default"
            className="bg-emerald-600 hover:bg-emerald-700"
          >
            {dispatching ? <Loader2 className="animate-spin" /> : <Play />}
            배차 실행 {settings.demo && "(Demo Mode)"}
          </Button>
        )}

        {!ready && (
          <span className="text-sm text-muted-foreground">
            두 파일을 모두 올려야 실행할 수 있습니다 — 무저장 구조라 매회 전체 입력이 필요합니다
          </span>
        )}
      </div>

      {parseError && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>파일 검증 실패</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">{parseError}</AlertDescription>
        </Alert>
      )}

      {preview && <PreviewPanel preview={preview} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────

function DropZone({
  title,
  description,
  file,
  onFile,
}: {
  title: string;
  description: string;
  file: File | null;
  onFile: (f: File | null) => void;
}) {
  const [over, setOver] = useState(false);
  const inputId = `file-${title.replace(/\W/g, "")}`;

  const accept = useCallback(
    (files: FileList | null) => {
      const f = files?.[0];
      if (!f) return;
      if (!/\.xlsx?$/i.test(f.name)) return;
      onFile(f);
    },
    [onFile]
  );

  return (
    <Card
      className={cn(
        "transition-colors",
        over && "border-primary bg-primary/5",
        file && "border-emerald-500/60"
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        accept(e.dataTransfer.files);
      }}
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {file ? (
            <CheckCircle2 className="size-4 text-emerald-600" />
          ) : (
            <Upload className="size-4 text-muted-foreground" />
          )}
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {file ? (
          <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{file.name}</div>
              <div className="text-xs text-muted-foreground">
                {(file.size / 1024).toFixed(0)} KB
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={() => onFile(null)} aria-label="파일 제거">
              <X />
            </Button>
          </div>
        ) : (
          <label
            htmlFor={inputId}
            className="flex h-20 cursor-pointer items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground hover:bg-accent/50"
          >
            드래그하거나 클릭해서 선택
          </label>
        )}
        <input
          id={inputId}
          type="file"
          accept=".xlsx,.xls"
          className="hidden"
          onChange={(e) => accept(e.target.files)}
        />
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────

function PreviewPanel({ preview }: { preview: ParseResponse }) {
  const w = preview.warnings;

  const conflicts = useMemo(
    () => preview.points.filter((p) => p.mismatch === "boundary" || p.mismatch === "missing"),
    [preview.points]
  );
  const refines = useMemo(
    () => preview.points.filter((p) => p.mismatch === "refine"),
    [preview.points]
  );
  const errors = preview.issues.filter((i) => i.level === "error");
  const warnings = preview.issues.filter((i) => i.level === "warning");

  return (
    <div className="space-y-6">
      {/* FR-07 파싱 요약 */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="출고일자" value={formatDate(preview.date)} />
        <Metric
          label="배차 대상 행"
          value={n(preview.targetRows)}
          sub={`총 ${n(preview.totalRows)}행 · 제외 ${n(preview.excludedRows)}행`}
        />
        <Metric label="납품처" value={`${n(preview.pointCount)}곳`} sub="납품처 + 주소 기준" />
        <Metric label="총 물량" value={`${n(preview.totalBoxes)} 박스`} />
        <Metric label="총 회전" value={`${preview.capacity.totalTrips}회전`} sub={`기사 ${preview.capacity.driverCount}명`} />
        <Metric
          label="적재 상한"
          value={`${n(preview.capacity.maxBoxes)} 박스`}
          sub={`하한 ${n(preview.capacity.minBoxes)} 박스`}
        />
        <Metric
          label="업체 수 상한"
          value={`${preview.capacity.maxCompanies}곳`}
          sub={`하한 ${preview.capacity.minCompanies}곳`}
        />
        <Metric
          label="제외 사유"
          value={preview.excluded.map((e) => `${e.reason} ${e.rows}`).join(" · ") || "없음"}
        />
      </div>

      {/* FR-08 구조적 미배차 사전 경고 */}
      {w.structuralShortfall > 0 && (
        <Alert>
          <AlertTriangle className="text-amber-600" />
          <AlertTitle>구조적 미배차 최소 {w.structuralShortfall}곳</AlertTitle>
          <AlertDescription>
            납품처 {preview.pointCount}곳이 회전당 업체 수 상한 합계 {preview.capacity.maxCompanies}
            곳을 넘습니다. 적재량과 무관하게 최소 {w.structuralShortfall}곳은 당일 배차가 불가능하며,
            기타(미배차)로 분류되어 용차 판단 대상이 됩니다.
          </AlertDescription>
        </Alert>
      )}

      {w.capacityShortfall > 0 && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>적재 상한 초과 {n(w.capacityShortfall)} 박스</AlertTitle>
          <AlertDescription>
            총 물량 {n(preview.totalBoxes)} 박스가 전 차량 적재 상한 {n(preview.capacity.maxBoxes)}{" "}
            박스를 넘습니다.
          </AlertDescription>
        </Alert>
      )}

      {w.belowMinimum && (
        <Alert>
          <Info />
          <AlertTitle>일부 차량 미운행 예상</AlertTitle>
          <AlertDescription>
            총 물량이 적재 하한 합계({n(preview.capacity.minBoxes)} 박스)보다 적습니다. 최소수량을
            채우지 못한 차량은 출고하지 않습니다 (R-04).
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="conditions">
        <TabsList>
          <TabsTrigger value="conditions">
            조건 구조화 <Badge variant="secondary" className="ml-1.5">{preview.points.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="review">
            담당자 확인
            <Badge variant={conflicts.length ? "destructive" : "secondary"} className="ml-1.5">
              {conflicts.length + errors.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="fleet">차량 마스터</TabsTrigger>
          <TabsTrigger value="issues">
            검증 이슈 <Badge variant="secondary" className="ml-1.5">{preview.issues.length}</Badge>
          </TabsTrigger>
        </TabsList>

        {/* 원문 | 해석 | 검증 3열 (FR-18) */}
        <TabsContent value="conditions">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">원문과 해석 대조</CardTitle>
              <CardDescription>
                납품시간 컬럼과 납품처명 원문을 함께 해석해 더 엄격한 쪽을 채택합니다 (FR-11).
                경계가 어긋난 건은 빨간색, 점심 등 배제 구간을 찾아낸 건은 파란색입니다.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <div className="max-h-[560px] overflow-auto">
                <Table>
                  <TableHeader className="sticky top-0 bg-card">
                    <TableRow>
                      <TableHead className="w-[190px]">업체 / 권역</TableHead>
                      <TableHead className="w-[80px] text-right">박스</TableHead>
                      <TableHead className="w-[240px]">원문</TableHead>
                      <TableHead className="w-[200px]">해석된 시간창</TableHead>
                      <TableHead>검증 결과</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview.points.map((p) => (
                      <ConditionRow key={p.id} p={p} />
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="review">
          <div className="grid gap-4 lg:grid-cols-2">
            <ReviewCard
              title="시간창 불일치 · 결손"
              description="납품시간 컬럼만 믿으면 시간 위반이 나는 건입니다"
              count={conflicts.length}
              tone={conflicts.length ? "warn" : "ok"}
            >
              {conflicts.map((p) => (
                <div key={p.id} className="rounded-md border p-3 text-sm">
                  <div className="font-medium">{p.company}</div>
                  <div className="mt-1 grid gap-0.5 text-xs text-muted-foreground">
                    <div>원문 · {p.conditionText || "(없음)"}</div>
                    <div>컬럼 · {p.columnRaw ?? "(비어있음)"}</div>
                    <div className="text-foreground">채택 · {p.windowsText}</div>
                  </div>
                  <div className="mt-1.5 text-xs text-amber-700 dark:text-amber-400">{p.note}</div>
                </div>
              ))}
            </ReviewCard>

            <ReviewCard
              title="조기납품 후보"
              description="한 기사에게 2곳 이상 배정되지 않습니다. 회전 번호에는 제약이 없고, 2회전 배정 가능 여부는 시간 실현성이 판단합니다 (R-08)"
              count={preview.earlyCandidates.length}
              tone="info"
            >
              {preview.earlyCandidates.map((c) => (
                <div key={c.company} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <span className="font-medium">{c.company}</span>
                  <span className="text-xs text-muted-foreground">{c.windowsText}</span>
                </div>
              ))}
            </ReviewCard>

            <ReviewCard
              title="배제 구간 세분화"
              description="컬럼이 담지 못한 점심시간을 원문에서 찾아냈습니다 (FR-12)"
              count={refines.length}
              tone="info"
            >
              {refines.map((p) => (
                <div key={p.id} className="rounded-md border px-3 py-2 text-sm">
                  <span className="font-medium">{p.company}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{p.windowsText}</span>
                </div>
              ))}
            </ReviewCard>

            <ReviewCard
              title="검증 오류"
              description="배차에 반영되지 않는 건입니다"
              count={errors.length}
              tone={errors.length ? "error" : "ok"}
            >
              {errors.map((i, idx) => (
                <div key={idx} className="rounded-md border p-3 text-sm">
                  <div className="font-medium">
                    [{i.code}] {i.subject}
                  </div>
                  <div className="text-xs text-muted-foreground">{i.message}</div>
                </div>
              ))}
            </ReviewCard>
          </div>
        </TabsContent>

        <TabsContent value="fleet">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">차량 마스터 (읽기 전용)</CardTitle>
              <CardDescription>
                화면에서 수정할 수 없습니다. 값을 바꾸려면 차량_톤수.xlsx를 고쳐 다시 업로드하십시오 (§11 ②).
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>기사명</TableHead>
                    <TableHead>톤수</TableHead>
                    <TableHead className="text-right">적재 범위</TableHead>
                    <TableHead className="text-center">회전</TableHead>
                    <TableHead className="text-center">업체 수</TableHead>
                    <TableHead>도착지</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.vehicles.map((v) => (
                    <TableRow key={v.id}>
                      <TableCell className="font-medium">{v.기사명}</TableCell>
                      <TableCell>{v.톤수라벨}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {n(v.최소수량)} ~ {n(v.최대수량)}
                      </TableCell>
                      <TableCell className="text-center">{v.회전수}</TableCell>
                      <TableCell className="text-center">
                        {v.최소업체수}~{v.최대업체수}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{v.도착지}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="issues">
          <Card>
            <CardContent className="space-y-2 pt-6">
              {preview.issues.length === 0 && (
                <div className="text-sm text-muted-foreground">검증 이슈가 없습니다.</div>
              )}
              {[...errors, ...warnings, ...preview.issues.filter((i) => i.level === "info")].map(
                (i, idx) => (
                  <div
                    key={idx}
                    className={cn(
                      "rounded-md border p-3 text-sm",
                      i.level === "error" && "border-destructive/40 bg-destructive/5",
                      i.level === "warning" && "border-amber-500/40 bg-amber-500/5"
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">
                        {i.code}
                      </Badge>
                      {i.subject && <span className="font-medium">{i.subject}</span>}
                    </div>
                    <div className="mt-1">{i.message}</div>
                    {i.detail && (
                      <div className="mt-1 text-xs text-muted-foreground">{i.detail}</div>
                    )}
                  </div>
                )
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ConditionRow({ p }: { p: PreviewPoint }) {
  const tone =
    p.mismatch === "boundary" || p.mismatch === "missing"
      ? "bg-amber-500/5"
      : p.mismatch === "refine"
        ? "bg-sky-500/5"
        : undefined;

  return (
    <TableRow className={tone}>
      <TableCell>
        <div className="font-medium">{p.company}</div>
        <div className="text-xs text-muted-foreground">
          {p.courseCode !== null && <span className="mr-1 opacity-70">[{p.courseCode}]</span>}
          {p.region}
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">{n(p.boxes)}</TableCell>
      <TableCell className="text-xs">
        <div className="text-muted-foreground">컬럼 · {p.columnRaw ?? "(비어있음)"}</div>
        <div className="text-muted-foreground">원문 · {p.conditionText || "(없음)"}</div>
      </TableCell>
      <TableCell>
        <div className="font-mono text-xs">{p.windowsText}</div>
        {p.tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {p.tags.map((t) => (
              <Badge key={t} variant="outline" className="text-[10px] font-normal">
                {t}
              </Badge>
            ))}
          </div>
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{p.note}</TableCell>
    </TableRow>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
        {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function ReviewCard({
  title,
  description,
  count,
  tone,
  children,
}: {
  title: string;
  description: string;
  count: number;
  tone: "ok" | "warn" | "error" | "info";
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {title}
          <Badge
            variant={tone === "error" ? "destructive" : tone === "warn" ? "default" : "secondary"}
          >
            {count}
          </Badge>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="max-h-80 space-y-2 overflow-auto">
        {count === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-emerald-600" /> 해당 없음
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}
