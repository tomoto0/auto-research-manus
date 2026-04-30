# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
pnpm install                # Install dependencies
pnpm run dev                # Start dev server (tsx watch, hot reload)
pnpm run build              # Production build (Vite frontend + esbuild backend)
pnpm run start              # Start production server
pnpm run check              # TypeScript type-check (no emit)
pnpm run test               # Run full test suite (vitest)
pnpm run format             # Prettier format all files
pnpm run db:push            # Generate and run Drizzle migrations

# Run a single test file
pnpm exec vitest run server/auth.logout.test.ts

# Run a single named test
pnpm exec vitest run server/pipeline.test.ts -t "test name here"
```

**Note:** `pnpm run test -- server/file.test.ts` is misleading (Vitest still runs broader tests). Always use `pnpm exec vitest run <file>` for single-file runs. `server/pipeline.test.ts` has known pre-existing failures.

## Architecture

Full-stack TypeScript app: React 19 + Vite frontend, Express + tRPC 11 backend, TiDB/MySQL via Drizzle ORM, S3 object storage via Manus Forge proxy.

### Request Flow
- Browser uses tRPC client (`client/src/lib/trpc.ts`) with React Query + superjson; standalone async functions (e.g. chunked upload) use the vanilla client (`client/src/lib/trpc-client.ts`)
- Server mounts tRPC at `/api/trpc` (`server/_core/index.ts`)
- Context (`server/_core/context.ts`) injects authenticated user from Manus OAuth session
- Most procedures are `publicProcedure`; `protectedProcedure` exists for auth-required endpoints

### Core Pipeline System
- **23-stage state machine** in `server/pipeline-engine.ts` — the core product
- Stage definitions and `RunConfig` types in `shared/pipeline.ts`
- DB persistence via `server/db.ts` using Drizzle tables in `drizzle/schema.ts`
- Real-time updates via SSE at `/api/pipeline/events/:runId` with in-memory event buffering in `server/routers.ts`
  - **Note:** Dev環境でパイプライン起動直後にブラウザコンソールに `EventSource's response has a MIME type ("text/html")` エラーが出るのは既知の無害な挙動（Vite SPA fallbackがSSEリクエストをキャッチするため）。分析は正常に進行する
- Manual approval mode (`autoApprove=false`) pauses after each stage; approval/rejection handled via router mutations and in-memory waiters (`waitForApproval`, `updateContextFromEdit` in pipeline-engine)
- Run IDs follow format: `rc-${Date.now()}-${nanoid(8)}`

### Key Server Modules
- `server/literature.ts` — parallel literature search across arXiv, Semantic Scholar, Springer, PubMed, CrossRef with deduplication
- `server/experiment-runner.ts` — sandboxed Python execution for data analysis (5-min timeout)
- `server/pdf-generator.ts` — PDFKit-based PDF generation with embedded charts
- `server/storage.ts` — S3 proxy via Forge API (`BUILT_IN_FORGE_API_URL`)
- `server/_core/llm.ts` — centralized LLM calls via Forge chat completions (currently uses `gemini-2.5-flash`)
- `server/dta-parser.ts` — Stata .dta file parser
- `server/upload-procedures.ts` — tRPC mutations for chunked dataset upload (uploadChunk, assembleChunks, registerFile)

### Dataset Upload Flow
Chunked S3 proxy upload via tRPC mutations on the `datasets` router: client splits files into 8MB chunks, base64-encodes each → `datasets.uploadChunk` → `datasets.assembleChunks` (multi-chunk only) → `datasets.registerFile`. Upload procedures live in `server/upload-procedures.ts`; the client-side logic is in `client/src/lib/chunked-upload.ts` using the vanilla tRPC client. `longRunningProcedure` (defined in `server/_core/trpc.ts`) sets a 10-minute request timeout for assemble/register. User ID is derived from `ctx.user` (automatic auth). Max dataset size: 250MB. Supported types: CSV, Excel (.xlsx/.xls), Stata (.dta), JSON, TSV.

### Frontend
- React 19 SPA with wouter routing, Tailwind CSS 4, shadcn/ui components
- Pages: Home, Dashboard, RunDetail, History, Settings
- Path aliases: `@/*` → `client/src/*`, `@shared/*` → `shared/*`

## Important Conventions

- **Pipeline state is dual-tracked:** always update both DB state and emitted SSE events when changing stage lifecycle
- **Status enums differ:** Run: `pending | running | completed | failed | stopped | awaiting_approval`. Stage: `pending | running | done | failed | blocked_approval | skipped`
- **Anti-hallucination prompts in stages 12–20** prevent fabricated metrics/citations — preserve these guardrails when editing prompts
- **Citation flow:** Stage 18 expects numbered citations → Stage 20 converts to LaTeX with bibliography integrity checks
- **If adding stages with context outputs**, update `updateContextFromEdit` in pipeline-engine so manual edits propagate
- **Startup cleanup:** `cleanupStaleRuns()` marks `running/pending` runs as `failed` on server boot

## Environment Variables

Required: `DATABASE_URL`, `JWT_SECRET`, `VITE_APP_ID`, `OAUTH_SERVER_URL`, `BUILT_IN_FORGE_API_URL`, `BUILT_IN_FORGE_API_KEY`
Optional (improves literature coverage): `SEMANTIC_SCHOLAR_API_KEY`, `SPRINGER_API_KEY`
