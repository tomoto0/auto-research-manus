# Copilot Instructions for `auto-research-claw`

## Build, test, and check commands

- Install dependencies:
  - `pnpm install`
- Type-check:
  - `pnpm run check`
- Full test suite:
  - `pnpm run test`
- Run a single test file:
  - `pnpm exec vitest run server/auth.logout.test.ts`
- Run a single named test:
  - `pnpm exec vitest run server/auth.logout.test.ts -t "clears the session cookie and reports success"`
- Production build:
  - `pnpm run build`
- Start dev server:
  - `pnpm run dev`
- Run DB migrations:
  - `pnpm run db:push`

Notes from current baseline:
- `pnpm run check` passes.
- `pnpm run build` passes (with Vite warnings if analytics env vars are unset).
- `pnpm run test` currently has existing failures in `server/pipeline.test.ts`; do not assume a fully green baseline.
- `pnpm run test -- server/auth.logout.test.ts` is misleading because Vitest still runs broader tests; prefer `pnpm exec vitest run <file>`.

## High-level architecture

- Full-stack TypeScript app:
  - Frontend: React + Vite under `client/src`
  - Backend: Express + tRPC under `server/`
  - Shared contracts/types: `shared/`
  - DB schema/migrations: `drizzle/`

- Request flow:
  - Browser uses tRPC client (`client/src/lib/trpc.ts`) with React Query and `superjson`.
  - Server mounts tRPC at `/api/trpc` in `server/_core/index.ts`.
  - Context (`server/_core/context.ts`) injects optional authenticated user from Manus OAuth session.

- Authentication model:
  - OAuth callback in `server/_core/oauth.ts` exchanges code, upserts user, and sets `app_session_id` cookie.
  - Most app procedures are currently `publicProcedure`; auth guard exists (`protectedProcedure`) for endpoints that require login.

- Pipeline system (core product):
  - Defined as a 23-stage state machine in `server/pipeline-engine.ts`.
  - Stage definitions and config live in `shared/pipeline.ts`.
  - Pipeline run metadata, stage logs, papers, artifacts, datasets, and experiment results are persisted via Drizzle tables in `drizzle/schema.ts` and helper methods in `server/db.ts`.
  - Real-time status uses SSE endpoint `/api/pipeline/events/:runId` plus in-memory event buffering/listeners in `server/routers.ts`.
  - Manual approval mode (`autoApprove=false`) pauses after each stage with approval/rejection handled via router mutations and in-memory waiters.

- Data + execution layers:
  - Literature aggregation (`server/literature.ts`) queries arXiv, Semantic Scholar, Springer, PubMed, and CrossRef in parallel, then validates/deduplicates results.
  - Dataset uploads use chunked server-mediated S3 proxy flow:
    - Client uploader: `client/src/lib/chunked-upload.ts`
    - Server endpoints: `/api/upload/s3chunk`, `/api/upload/assemble`, `/api/upload/register`
  - Analysis/execution (`server/experiment-runner.ts`) parses CSV/TSV/Excel/DTA/JSON, handles encoding detection, generates chart/table outputs, and stores artifacts.
  - PDF generation (`server/pdf-generator.ts`) is PDFKit-based and can embed generated chart images.

- Storage and platform coupling:
  - Artifact/data storage uses Manus Forge storage proxy (`server/storage.ts`) with `BUILT_IN_FORGE_API_URL` and `BUILT_IN_FORGE_API_KEY`.
  - LLM calls are centralized in `server/_core/llm.ts` via Forge chat completions.

## Key repository-specific conventions

- Run IDs and pipeline identity:
  - New runs use `rc-${Date.now()}-${nanoid(8)}` in `pipeline.start`.
  - Keep this format when adding features tied to run identifiers.

- Pipeline state is persisted + streamed:
  - Always update both DB state and emitted events when changing stage lifecycle behavior.
  - Stage status enums differ from run status enums; follow existing constants:
    - Run: `pending | running | completed | failed | stopped | awaiting_approval`
    - Stage: `pending | running | done | failed | blocked_approval | skipped`

- Manual approval wiring:
  - Approval pause logic is centralized in `waitForApproval` and `updateContextFromEdit` in `server/pipeline-engine.ts`.
  - If you add/edit stages with context outputs, update `updateContextFromEdit` so user edits propagate.

- Upload constraints:
  - Max dataset size is 250MB.
  - Chunk uploads target 8MB chunks and pass through `/api/upload/s3chunk`.
  - Supported dataset extensions/types are tightly coupled across client validation and server parsing (`csv`, `xlsx/xls`, `dta`, `json`, `tsv`).

- Anti-hallucination safeguards are deliberate:
  - Pipeline stages 12–20 include strict prompt rules to prevent fabricated metrics/citations.
  - Keep these guardrails intact when editing prompts or result formatting.

- Citation/reference handling:
  - Stage 18 body writing expects numbered citations; stage 20 converts to LaTeX citation form and enforces bibliography integrity.
  - If modifying paper generation, preserve the citation flow and bibliography fallback logic.

- Environment assumptions:
  - Required for normal operation: `DATABASE_URL`, `JWT_SECRET`, `VITE_APP_ID`, `OAUTH_SERVER_URL`, `BUILT_IN_FORGE_API_URL`, `BUILT_IN_FORGE_API_KEY`.
  - Optional but impactful for literature coverage: `SEMANTIC_SCHOLAR_API_KEY`, `SPRINGER_API_KEY`.

- Startup behavior:
  - On server boot, `cleanupStaleRuns()` marks `running/pending` runs as failed. Keep this in mind for restart semantics and tests.

- Aliases and imports:
  - Use `@/*` for client code and `@shared/*` for shared modules, as configured in both Vite and Vitest configs.
