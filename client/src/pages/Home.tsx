import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { getLoginUrl } from "@/const";
import { chunkedUpload, type ChunkedUploadProgress } from "@/lib/chunked-upload";
import { Progress } from "@/components/ui/progress";
import { useState, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import {
  Beaker, Sparkles, BookOpen, Code, FileText, Users, ArrowRight,
  Loader2, Zap, Search, BarChart3, PenTool, ChevronRight, FlaskConical,
  Upload, X, FileSpreadsheet, Database, File as FileIcon
} from "lucide-react";
import { toast } from "sonner";
import { CONFERENCE_TEMPLATES } from "../../../shared/pipeline";

const PHASES = [
  {
    title: "Literature & Gap Analysis",
    icon: Search,
    color: "from-blue-500/20 to-blue-600/5",
    borderColor: "border-blue-500/30",
    iconColor: "text-blue-400",
    stages: ["Topic Analysis", "Literature Search", "Paper Screening", "Deep Analysis", "Gap Identification"],
  },
  {
    title: "Hypothesis & Method Design",
    icon: Sparkles,
    color: "from-violet-500/20 to-violet-600/5",
    borderColor: "border-violet-500/30",
    iconColor: "text-violet-400",
    stages: ["Hypothesis Generation", "Method Design", "Method Validation"],
  },
  {
    title: "Experiment Execution",
    icon: Code,
    color: "from-emerald-500/20 to-emerald-600/5",
    borderColor: "border-emerald-500/30",
    iconColor: "text-emerald-400",
    stages: ["Code Generation", "Code Review", "Experiment Execution", "Result Collection"],
  },
  {
    title: "Analysis & Visualization",
    icon: BarChart3,
    color: "from-amber-500/20 to-amber-600/5",
    borderColor: "border-amber-500/30",
    iconColor: "text-amber-400",
    stages: ["Statistical Analysis", "Figure Generation", "Table Generation"],
  },
  {
    title: "Paper Writing",
    icon: PenTool,
    color: "from-rose-500/20 to-rose-600/5",
    borderColor: "border-rose-500/30",
    iconColor: "text-rose-400",
    stages: ["Outline", "Abstract", "Body Writing", "References", "LaTeX Compilation"],
  },
  {
    title: "Review & Finalization",
    icon: Users,
    color: "from-cyan-500/20 to-cyan-600/5",
    borderColor: "border-cyan-500/30",
    iconColor: "text-cyan-400",
    stages: ["Peer Review", "Revision", "Final Compilation"],
  },
];

const DATA_SOURCES = [
  { name: "arXiv", desc: "Preprint server", color: "bg-red-500/10 text-red-400 border-red-500/20" },
  { name: "Semantic Scholar", desc: "AI-powered search", color: "bg-blue-500/10 text-blue-400 border-blue-500/20" },
  { name: "Springer", desc: "Academic publisher", color: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
  { name: "PubMed", desc: "Biomedical literature", color: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
  { name: "CrossRef", desc: "Metadata registry", color: "bg-violet-500/10 text-violet-400 border-violet-500/20" },
];

const FILE_TYPE_ICONS: Record<string, React.ElementType> = {
  csv: FileSpreadsheet,
  excel: FileSpreadsheet,
  dta: Database,
  json: FileIcon,
  tsv: FileSpreadsheet,
  other: FileIcon,
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

export default function Home() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const [topic, setTopic] = useState("");
  const [autoApprove, setAutoApprove] = useState(true);
  const [targetConference, setTargetConference] = useState("General");
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<ChunkedUploadProgress | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const startMutation = trpc.pipeline.start.useMutation({
    onSuccess: (data) => {
      toast.success("Research pipeline started!");
      setLocation(`/run/${data.runId}`);
    },
    onError: (err) => {
      toast.error(`Failed to start: ${err.message}`);
    },
  });

  const handleStart = () => {
    if (!topic.trim()) {
      toast.error("Please enter a research topic");
      return;
    }
    startMutation.mutate({
      topic: topic.trim(),
      autoApprove,
      datasetFileIds: uploadedFiles.map(f => f.id),
      config: { targetConference },
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

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border/40 bg-background/90 backdrop-blur-md sticky top-0 z-50">
        <div className="container flex h-14 items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-lg bg-primary/15 flex items-center justify-center">
              <FlaskConical className="h-4.5 w-4.5 text-primary" />
            </div>
            <span className="font-semibold text-base tracking-tight">Auto Research</span>
          </div>
          <div className="flex items-center gap-2">
            {user ? (
              <Button variant="default" size="sm" onClick={() => setLocation("/dashboard")} className="gap-1.5 h-8 text-xs">
                Dashboard <ArrowRight className="h-3 w-3" />
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => { window.location.href = getLoginUrl(); }} className="h-8 text-xs">
                Sign in
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="pt-16 pb-20 md:pt-24 md:pb-28 relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_-10%,oklch(0.45_0.15_260_/_0.2),transparent)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_80%_80%,oklch(0.5_0.12_200_/_0.08),transparent)]" />
        <div className="container relative">
          <div className="max-w-2xl mx-auto text-center space-y-6">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-xs font-medium text-primary">
              <Zap className="h-3 w-3" /> 23-Stage Autonomous Research Pipeline
            </div>
            <h1 className="text-3xl md:text-5xl font-bold tracking-tight leading-[1.15]">
              From Research Topic to
              <span className="bg-gradient-to-r from-primary to-blue-400 bg-clip-text text-transparent"> Published Paper</span>
            </h1>
            <p className="text-sm md:text-base text-muted-foreground max-w-lg mx-auto leading-relaxed">
              Enter a research topic and let AI handle everything: literature search across 5 databases,
              hypothesis generation, experiment execution, statistical analysis, paper writing, and peer review.
            </p>

            {/* Input Form */}
            <div className="max-w-xl mx-auto space-y-3 pt-2">
              <div className="flex gap-2">
                <Input
                  placeholder="e.g., Transformer attention mechanisms for time series forecasting"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !startMutation.isPending) handleStart(); }}
                  className="h-11 text-sm bg-card/80 border-border/50 placeholder:text-muted-foreground/40 focus:border-primary/50"
                />
                <Button
                  onClick={handleStart}
                  disabled={startMutation.isPending || !topic.trim()}
                  className="h-11 px-5 font-medium shrink-0 gap-1.5"
                >
                  {startMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Beaker className="h-4 w-4" />
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
                <div className="space-y-1.5 text-left">
                  <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">
                    Attached Datasets ({uploadedFiles.length})
                  </p>
                  {uploadedFiles.map((file, idx) => {
                    const FTypeIcon = FILE_TYPE_ICONS[file.fileType] || FileIcon;
                    return (
                      <div
                        key={idx}
                        className="flex items-center gap-2.5 bg-muted/30 rounded-md px-3 py-2 text-xs group"
                      >
                        <FTypeIcon className="h-4 w-4 text-primary/70 shrink-0" />
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
                    Data will be analyzed with Python (pandas, matplotlib, seaborn) during the experiment stage
                  </p>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
                <div className="flex items-center gap-2">
                  <Switch checked={autoApprove} onCheckedChange={setAutoApprove} id="auto-approve" className="scale-90" />
                  <label htmlFor="auto-approve" className="cursor-pointer select-none">Auto-approve all stages</label>
                </div>
                <div className="flex items-center gap-2">
                  <FileText className="h-3.5 w-3.5 text-muted-foreground/60" />
                  <Select value={targetConference} onValueChange={setTargetConference}>
                    <SelectTrigger className="h-7 w-[160px] text-xs bg-card/80 border-border/50">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CONFERENCE_TEMPLATES.map((t) => (
                        <SelectItem key={t.id} value={t.name} className="text-xs">
                          <span className="font-medium">{t.name}</span>
                          <span className="text-muted-foreground ml-1">({t.description})</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {!user && (
                <p className="text-[11px] text-muted-foreground/60 text-center">
                  No login required to start. Sign in to save history and manage runs.
                </p>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Pipeline Phases */}
      <section className="py-16 border-t border-border/20">
        <div className="container">
          <div className="text-center mb-10">
            <h2 className="text-xl font-bold mb-2">23 Stages, 6 Phases</h2>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Each phase builds on the previous, creating a complete research workflow from topic analysis to final paper.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-w-5xl mx-auto">
            {PHASES.map((phase, i) => (
              <Card key={i} className={`bg-gradient-to-br ${phase.color} border ${phase.borderColor} hover:shadow-lg hover:shadow-primary/5 transition-all duration-300`}>
                <CardContent className="p-5">
                  <div className="flex items-center gap-3 mb-3">
                    <div className={`h-9 w-9 rounded-lg bg-background/50 flex items-center justify-center ${phase.iconColor}`}>
                      <phase.icon className="h-4.5 w-4.5" />
                    </div>
                    <div>
                      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Phase {i + 1}</p>
                      <h3 className="text-sm font-semibold leading-tight">{phase.title}</h3>
                    </div>
                  </div>
                  <div className="space-y-1">
                    {phase.stages.map((s, j) => (
                      <div key={j} className="flex items-center gap-2 text-xs text-muted-foreground/80">
                        <ChevronRight className="h-3 w-3 shrink-0 opacity-40" />
                        <span>{s}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Data Sources */}
      <section className="py-16 border-t border-border/20">
        <div className="container">
          <div className="text-center mb-10">
            <h2 className="text-xl font-bold mb-2">5 Literature Data Sources</h2>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Comprehensive literature search across major academic databases with automatic deduplication.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-3 max-w-2xl mx-auto">
            {DATA_SOURCES.map((src) => (
              <div key={src.name} className={`flex items-center gap-2.5 px-4 py-2.5 rounded-xl border ${src.color} transition-all hover:scale-105`}>
                <BookOpen className="h-4 w-4 shrink-0" />
                <div>
                  <p className="text-sm font-medium">{src.name}</p>
                  <p className="text-[10px] opacity-70">{src.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border/20 py-6">
        <div className="container text-center text-xs text-muted-foreground/60">
          Auto Research - Autonomous AI Research Pipeline
        </div>
      </footer>
    </div>
  );
}
