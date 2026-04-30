import { useState, useMemo, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { chunkedUpload, type ChunkedUploadProgress } from "@/lib/chunked-upload";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Beaker, Play, Loader2, CheckCircle2, XCircle, Clock, StopCircle,
  ArrowRight, Sparkles, PauseCircle, FileText, Upload, X, FileSpreadsheet,
  Database, File
} from "lucide-react";
import { toast } from "sonner";
import { CONFERENCE_TEMPLATES } from "../../../shared/pipeline";

const STATUS_CONFIG: Record<string, { label: string; icon: React.ElementType; color: string; badgeClass: string }> = {
  running: { label: "Running", icon: Loader2, color: "text-blue-400", badgeClass: "bg-blue-500/15 text-blue-400 border-blue-500/25" },
  completed: { label: "Completed", icon: CheckCircle2, color: "text-emerald-400", badgeClass: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25" },
  failed: { label: "Failed", icon: XCircle, color: "text-red-400", badgeClass: "bg-red-500/15 text-red-400 border-red-500/25" },
  pending: { label: "Pending", icon: Clock, color: "text-amber-400", badgeClass: "bg-amber-500/15 text-amber-400 border-amber-500/25" },
  stopped: { label: "Stopped", icon: StopCircle, color: "text-gray-400", badgeClass: "bg-gray-500/15 text-gray-400 border-gray-500/25" },
  awaiting_approval: { label: "Awaiting Approval", icon: PauseCircle, color: "text-orange-400", badgeClass: "bg-orange-500/15 text-orange-400 border-orange-500/25" },
};

const FILE_TYPE_ICONS: Record<string, React.ElementType> = {
  csv: FileSpreadsheet,
  excel: FileSpreadsheet,
  dta: Database,
  json: File,
  tsv: FileSpreadsheet,
  other: File,
};

const ACCEPTED_EXTENSIONS = ".csv,.xlsx,.xls,.dta,.json,.tsv";

interface UploadedFile {
  id: number;
  originalName: string;
  fileType: string;
  sizeBytes: number;
  columnNames: string[] | null;
  rowCount: number | null;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const [topic, setTopic] = useState("");
  const [autoApprove, setAutoApprove] = useState(true);
  const [targetConference, setTargetConference] = useState("General");
  const [outcome, setOutcome] = useState("");
  const [treatment, setTreatment] = useState("");
  const [entity, setEntity] = useState("");
  const [time, setTime] = useState("");
  const [controls, setControls] = useState("");
  const [subgroup, setSubgroup] = useState("");
  const [missingDataMode, setMissingDataMode] = useState<"complete_case" | "mean_imputation">("complete_case");
  const [missingDataStrategy, setMissingDataStrategy] = useState("");
  const [variableNotes, setVariableNotes] = useState("");
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<ChunkedUploadProgress | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: runs, isLoading: runsLoading } = trpc.pipeline.list.useQuery(
    { limit: 10 },
    { refetchInterval: 5000 }
  );

  const startMutation = trpc.pipeline.start.useMutation({
    onSuccess: (data) => {
      toast.success("Research pipeline started!");
      setLocation(`/run/${data.runId}`);
    },
    onError: (err) => toast.error(`Failed to start: ${err.message}`),
  });

  const handleStart = () => {
    if (!topic.trim()) {
      toast.error("Please enter a research topic");
      return;
    }

    const normalize = (value: string) => {
      const trimmed = value.trim();
      return trimmed ? trimmed : undefined;
    };
    const controlVariables = controls
      .split(",")
      .map(value => value.trim())
      .filter(Boolean);
    const analysisInputs = {
      outcome: normalize(outcome),
      treatment: normalize(treatment),
      entity: normalize(entity),
      time: normalize(time),
      controls: controlVariables.length > 0 ? controlVariables : undefined,
      subgroup: normalize(subgroup),
      missingDataMode,
      missingDataStrategy: normalize(missingDataStrategy),
      variableNotes: normalize(variableNotes),
    };
    const hasAnalysisInputs = Object.values(analysisInputs).some(value =>
      Array.isArray(value) ? value.length > 0 : Boolean(value)
    );

    startMutation.mutate({
      topic: topic.trim(),
      autoApprove,
      datasetFileIds: uploadedFiles.map(f => f.id),
      config: {
        targetConference,
        analysisInputs: hasAnalysisInputs ? analysisInputs : undefined,
      },
    });
  };

  const uploadFile = useCallback(async (file: globalThis.File) => {
    const maxSize = 250 * 1024 * 1024;
    if (file.size > maxSize) {
      toast.error(`File too large: ${file.name} (max 250MB)`);
      return;
    }

    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    const allowedExts = ["csv", "xlsx", "xls", "dta", "json", "tsv"];
    if (!allowedExts.includes(ext)) {
      toast.error(`Unsupported file type: .${ext}. Accepted: ${allowedExts.join(", ")}`);
      return;
    }

    setIsUploading(true);
    setUploadProgress(null);
    try {
      const result = await chunkedUpload(file, (progress) => {
        setUploadProgress(progress);
      });
      if (result.success && result.file) {
        const fileInfo: UploadedFile = {
          id: result.file.id,
          originalName: result.file.originalName,
          fileType: result.file.fileType,
          sizeBytes: result.file.sizeBytes,
          columnNames: result.file.columnNames,
          rowCount: result.file.rowCount,
        };
        setUploadedFiles(prev => [...prev, fileInfo]);
        toast.success(`Uploaded: ${file.name}`);
      } else {
        throw new Error(result.error || "Upload failed");
      }
    } catch (err: any) {
      toast.error(err.message || "Upload failed");
    } finally {
      setIsUploading(false);
      setUploadProgress(null);
    }
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach(uploadFile);
    e.target.value = "";
  }, [uploadFile]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = e.dataTransfer.files;
    Array.from(files).forEach(uploadFile);
  }, [uploadFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const removeFile = (index: number) => {
    setUploadedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const stats = useMemo(() => {
    if (!runs) return { total: 0, running: 0, completed: 0, failed: 0, awaiting: 0 };
    return {
      total: runs.length,
      running: runs.filter((r: any) => r.status === "running" || r.status === "pending").length,
      completed: runs.filter((r: any) => r.status === "completed").length,
      failed: runs.filter((r: any) => r.status === "failed").length,
      awaiting: runs.filter((r: any) => r.status === "awaiting_approval").length,
    };
  }, [runs]);

  return (
    <div className="space-y-6">
      {/* New Pipeline Card */}
      <Card className="border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            New Research Pipeline
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              placeholder="Enter your research topic..."
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !startMutation.isPending) handleStart(); }}
              className="h-10 text-sm bg-background/60 border-border/50"
            />
            <Button
              onClick={handleStart}
              disabled={startMutation.isPending || !topic.trim()}
              className="h-10 px-5 shrink-0 gap-1.5"
            >
              {startMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              Start
            </Button>
          </div>

          {/* File Upload Zone */}
          <div
            className={`relative border-2 border-dashed rounded-lg p-4 transition-all cursor-pointer ${
              isDragOver
                ? "border-primary bg-primary/5"
                : "border-border/40 hover:border-border/70 hover:bg-muted/20"
            }`}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_EXTENSIONS}
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />
            <div className="flex flex-col items-center gap-1.5 text-center w-full">
              {isUploading ? (
                <Loader2 className="h-6 w-6 text-primary animate-spin" />
              ) : (
                <Upload className="h-6 w-6 text-muted-foreground/50" />
              )}
              <div className="w-full">
                {isUploading && uploadProgress ? (
                  <div className="space-y-1.5 px-4">
                    <p className="text-xs text-muted-foreground">
                      {uploadProgress.phase === "initiating" && "Preparing upload..."}
                      {uploadProgress.phase === "uploading" && `Uploading chunk ${uploadProgress.chunkIndex + 1}/${uploadProgress.totalChunks}...`}
                      {uploadProgress.phase === "completing" && "Processing file..."}
                    </p>
                    <Progress value={uploadProgress.percent} className="h-1.5" />
                    <p className="text-[10px] text-muted-foreground/50">
                      {Math.round(uploadProgress.bytesUploaded / 1024 / 1024)}MB / {Math.round(uploadProgress.totalBytes / 1024 / 1024)}MB ({uploadProgress.percent}%)
                    </p>
                  </div>
                ) : (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Drop data files here or click to browse
                    </p>
                    <p className="text-[10px] text-muted-foreground/50 mt-0.5">
                      CSV, Excel (.xlsx), Stata (.dta), JSON, TSV — max 250MB
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Uploaded Files List */}
          {uploadedFiles.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">
                Attached Datasets ({uploadedFiles.length})
              </p>
              {uploadedFiles.map((file, idx) => {
                const FileIcon = FILE_TYPE_ICONS[file.fileType] || File;
                return (
                  <div
                    key={idx}
                    className="flex items-center gap-2.5 bg-muted/30 rounded-md px-3 py-2 text-xs group"
                  >
                    <FileIcon className="h-4 w-4 text-primary/70 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{file.originalName}</p>
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                        <span>{formatFileSize(file.sizeBytes)}</span>
                        {file.rowCount && <span>{file.rowCount.toLocaleString()} rows</span>}
                        {file.columnNames && <span>{file.columnNames.length} columns</span>}
                        <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">
                          {file.fileType}
                        </Badge>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={(e) => { e.stopPropagation(); removeFile(idx); }}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                );
              })}
              <p className="text-[10px] text-primary/60 flex items-center gap-1">
                <Beaker className="h-3 w-3" />
                Data will be analyzed by the deterministic TypeScript runner during the experiment stage
              </p>
            </div>
          )}

          <div className="space-y-2 rounded-lg border border-border/30 bg-background/40 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Research Setup
              </p>
              <span className="text-[10px] text-muted-foreground/70">
                Optional but recommended for causal/econometric runs
              </span>
            </div>

            <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
              <Input
                placeholder="Outcome column"
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
                className="h-9 text-xs bg-background/60 border-border/50"
              />
              <Input
                placeholder="Treatment column"
                value={treatment}
                onChange={(e) => setTreatment(e.target.value)}
                className="h-9 text-xs bg-background/60 border-border/50"
              />
              <Input
                placeholder="Control columns (comma separated)"
                value={controls}
                onChange={(e) => setControls(e.target.value)}
                className="h-9 text-xs bg-background/60 border-border/50"
              />
              <Input
                placeholder="Entity / panel ID"
                value={entity}
                onChange={(e) => setEntity(e.target.value)}
                className="h-9 text-xs bg-background/60 border-border/50"
              />
              <Input
                placeholder="Time column"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="h-9 text-xs bg-background/60 border-border/50"
              />
              <Input
                placeholder="Subgroup column"
                value={subgroup}
                onChange={(e) => setSubgroup(e.target.value)}
                className="h-9 text-xs bg-background/60 border-border/50"
              />
            </div>

            <div className="grid gap-2 lg:grid-cols-2">
              <div className="space-y-2">
                <p className="text-[11px] text-muted-foreground">Missing-data option</p>
                <Select value={missingDataMode} onValueChange={(value: "complete_case" | "mean_imputation") => setMissingDataMode(value)}>
                  <SelectTrigger className="h-9 text-xs bg-background/60 border-border/50">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="complete_case" className="text-xs">Complete-case (Recommended)</SelectItem>
                    <SelectItem value="mean_imputation" className="text-xs">Mean imputation for predictors</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-2 lg:grid-cols-2">
              <Textarea
                placeholder="Missing-data notes or exclusion rule"
                value={missingDataStrategy}
                onChange={(e) => setMissingDataStrategy(e.target.value)}
                className="min-h-[76px] text-xs bg-background/60 border-border/50"
              />
              <Textarea
                placeholder="Variable definitions, estimand notes, or column mapping"
                value={variableNotes}
                onChange={(e) => setVariableNotes(e.target.value)}
                className="min-h-[76px] text-xs bg-background/60 border-border/50"
              />
            </div>
          </div>

          {/* Options Row */}
          <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <Switch checked={autoApprove} onCheckedChange={setAutoApprove} id="dash-auto" className="scale-85" />
              <label htmlFor="dash-auto" className="cursor-pointer select-none">
                {autoApprove ? "Auto-approve all stages" : "Manual approval mode"}
              </label>
            </div>

            <div className="flex items-center gap-2">
              <FileText className="h-3.5 w-3.5 text-muted-foreground/60" />
              <Select value={targetConference} onValueChange={setTargetConference}>
                <SelectTrigger className="h-7 w-[140px] text-xs bg-background/60 border-border/50">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONFERENCE_TEMPLATES.map((t) => (
                    <SelectItem key={t.id} value={t.name} className="text-xs">
                      <span className="font-medium">{t.name}</span>
                      <span className="text-muted-foreground ml-1.5">({t.description.split(" ").slice(0, 3).join(" ")})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {!autoApprove && (
            <div className="flex items-start gap-2 text-xs text-orange-400/80 bg-orange-500/5 rounded-md p-2.5 border border-orange-500/10">
              <PauseCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>Manual mode: The pipeline will pause after each stage for your review. You can edit outputs before proceeding.</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: "Total Runs", value: stats.total, color: "text-foreground" },
          { label: "Running", value: stats.running, color: "text-blue-400" },
          { label: "Awaiting", value: stats.awaiting, color: "text-orange-400" },
          { label: "Completed", value: stats.completed, color: "text-emerald-400" },
          { label: "Failed", value: stats.failed, color: "text-red-400" },
        ].map((s) => (
          <Card key={s.label} className="bg-card/50">
            <CardContent className="p-4">
              <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{s.label}</p>
              <p className={`text-2xl font-bold mt-1 ${s.color}`}>{s.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Recent Runs */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">Recent Runs</h2>
          <Button variant="ghost" size="sm" onClick={() => setLocation("/history")} className="text-xs h-7 gap-1 text-muted-foreground">
            View all <ArrowRight className="h-3 w-3" />
          </Button>
        </div>

        {runsLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map(i => (
              <Card key={i} className="animate-pulse bg-card/50">
                <CardContent className="p-4 h-16" />
              </Card>
            ))}
          </div>
        ) : !runs || runs.length === 0 ? (
          <Card className="bg-card/30 border-dashed">
            <CardContent className="p-8 text-center">
              <Beaker className="h-8 w-8 mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground">No pipeline runs yet</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Enter a research topic above to get started</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {runs.map((run: any) => {
              const cfg = STATUS_CONFIG[run.status] || STATUS_CONFIG.pending;
              const StatusIcon = cfg.icon;
              const progress = run.totalStages > 0 ? Math.round((run.stagesDone / run.totalStages) * 100) : 0;
              return (
                <Card
                  key={run.runId}
                  className={`bg-card/50 hover:bg-card/80 transition-colors cursor-pointer group ${run.status === "awaiting_approval" ? "border-orange-500/30" : ""}`}
                  onClick={() => setLocation(`/run/${run.runId}`)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1.5">
                          <StatusIcon className={`h-3.5 w-3.5 shrink-0 ${cfg.color} ${run.status === "running" ? "animate-spin" : ""}`} />
                          <p className="text-sm font-medium truncate">{run.topic}</p>
                        </div>
                        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 h-5 font-normal ${cfg.badgeClass}`}>
                            {cfg.label}
                          </Badge>
                          <span>Stage {run.currentStage || 0}/{run.totalStages}</span>
                          <span>{new Date(run.createdAt).toLocaleDateString()}</span>
                        </div>
                        {(run.status === "running" || run.status === "pending") && (
                          <Progress value={progress} className="h-1 mt-2" />
                        )}
                        {run.status === "awaiting_approval" && (
                          <div className="flex items-center gap-1.5 mt-2 text-[11px] text-orange-400">
                            <PauseCircle className="h-3 w-3" />
                            <span>Waiting for your approval at Stage {run.currentStage}</span>
                          </div>
                        )}
                      </div>
                      <ArrowRight className="h-4 w-4 text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-colors shrink-0 mt-1" />
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
