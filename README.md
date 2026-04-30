# Auto Research

**AI-Powered Autonomous Research Paper Generator**

![Auto Research Banner](https://d2xsxph8kpxj0f.cloudfront.net/310419663027084947/gtQthQFbp8juSZFb2bGpao/ogp-auto-research-jZRFFLAzUta8MwfVEXBTnx.png)

Auto Research is a full-stack web application that transforms a research topic into a complete academic paper through a fully autonomous 23-stage pipeline. The system performs literature search across five major academic databases, generates hypotheses, designs and executes experiments with real data analysis, writes the paper body with proper citations, and conducts simulated peer review — all without manual intervention.

**Live Demo:** [https://auto-research.manus.space](https://auto-research.manus.space)

---

## Table of Contents

1. [Overview](#overview)
2. [Key Features](#key-features)
3. [Architecture](#architecture)
4. [Pipeline Stages](#pipeline-stages)
5. [Technology Stack](#technology-stack)
6. [Data File Upload & Analysis](#data-file-upload--analysis)
7. [Conference Templates](#conference-templates)
8. [Literature Data Sources](#literature-data-sources)
9. [Getting Started](#getting-started)
10. [Project Structure](#project-structure)
11. [Environment Variables](#environment-variables)
12. [License](#license)

---

## Overview

Auto Research addresses a fundamental challenge in academic research: the time-intensive process of moving from an initial idea to a polished paper. By orchestrating LLM-driven analysis, real-time literature search, a deterministic server-side analysis engine, and structured paper generation, the platform automates the entire research workflow while maintaining academic rigor.

The application supports two operational modes. In **fully autonomous mode**, all 23 stages execute sequentially without human intervention. In **manual approval mode**, users can review, edit, and approve the output of each stage before the pipeline advances, enabling fine-grained control over the research process.

---

## Key Features

| Feature | Description |
|---|---|
| **23-Stage Research Pipeline** | End-to-end automation from topic analysis to final paper compilation, organized into 6 phases |
| **Multi-Source Literature Search** | Simultaneous search across arXiv, Semantic Scholar, Springer, PubMed, and CrossRef with automatic deduplication |
| **Data File Upload** | Drag-and-drop upload of CSV, Excel (.xlsx), Stata (.dta), JSON, and TSV files for custom data analysis |
| **Deterministic Analysis Execution** | Server-side TypeScript analysis engine that runs schema-aware descriptive statistics, regression, panel, causal, and visualisation workflows on real uploaded data |
| **Econometrics & Causal Inference** | Built-in readiness gating plus robust OLS, panel fixed effects, difference-in-differences, event study, and synthetic control support with paper-ready outputs |
| **Automated Chart & Table Generation** | Statistical analysis results, econometric figures, and publication tables automatically generated and embedded in the paper |
| **Conference Template Support** | Paper formatting for NeurIPS, ICML, ICLR, ACL, AAAI, CVPR, EMNLP, and general academic formats |
| **Real-Time Progress Tracking** | Server-Sent Events (SSE) for live pipeline status updates in the browser |
| **Manual Approval Mode** | Stage-by-stage review with approve, edit, and reject controls |
| **PDF Generation** | Automatic PDF compilation from generated Markdown/LaTeX content |
| **Citation Management** | Proper in-text citations with numbered references derived from literature search results |
| **Artifact Management** | All generated outputs (papers, charts, data, PDFs) stored as downloadable artifacts with ZIP bundle support |

---

## Architecture

The application follows a modern full-stack architecture with a React frontend communicating with an Express/tRPC backend through type-safe RPC calls. The pipeline engine operates as a server-side state machine that orchestrates LLM calls, external API requests, and deterministic server-side analysis execution.

![Architecture Diagram](https://d2xsxph8kpxj0f.cloudfront.net/310419663027084947/gtQthQFbp8juSZFb2bGpao/architecture_ec3e1be1.png)

The architecture consists of five primary layers:

**Frontend Layer** — A React 19 single-page application styled with Tailwind CSS 4 and shadcn/ui components. The frontend communicates through type-safe tRPC clients (React hooks + vanilla client). Real-time pipeline updates are delivered via Server-Sent Events (SSE), and dataset uploads use a chunked tRPC flow.

**API Layer** — An Express 4 server exposing tRPC procedures for all application logic. Manus OAuth handles authentication, and the tRPC context injects the authenticated user into every protected procedure. Additional REST endpoints provide SSE streaming and artifact download routes.

**Pipeline Engine** — A 23-stage state machine that manages the research workflow. Each stage receives context from previous stages, invokes the LLM for content generation, and persists results to the database. The engine supports auto-approve and manual-approval modes, error recovery with configurable retries, and graceful shutdown.

**Execution Layer** — A deterministic Node/TypeScript analysis engine for data analysis and chart generation. The LLM proposes analysis plans, but the server executes validated statistics, econometric estimators, and Chart.js rendering directly over uploaded datasets, then uploads the resulting artifacts to S3.

**Storage Layer** — TiDB (MySQL-compatible) for relational data managed through Drizzle ORM, and S3 object storage for binary artifacts including uploaded datasets, generated charts, and compiled PDFs.

---

## Pipeline Stages

The 23-stage pipeline is organized into 6 sequential phases:

| Phase | Stages | Description |
|---|---|---|
| **1. Literature & Gap Analysis** | 1–5 | Topic analysis, multi-source literature search, paper screening, deep analysis, research gap identification |
| **2. Hypothesis & Method Design** | 6–8 | Hypothesis generation from identified gaps, methodology design, feasibility validation |
| **3. Experiment Execution** | 9–12 | Code generation (with dataset integration), code review, sandboxed experiment execution, result collection |
| **4. Analysis & Visualization** | 13–15 | Statistical analysis, figure/chart generation, result table generation |
| **5. Paper Writing** | 16–20 | Outline generation, abstract writing, body writing with citations and data results, references, LaTeX compilation |
| **6. Review & Finalization** | 21–23 | Simulated peer review, revision based on feedback, final compilation and PDF generation |

Each stage produces structured output that feeds into subsequent stages, creating a coherent research narrative from start to finish.

---

## Technology Stack

| Layer | Technology |
|---|---|
| **Frontend Framework** | React 19 with TypeScript |
| **Styling** | Tailwind CSS 4, shadcn/ui components |
| **State Management** | TanStack React Query (via tRPC) |
| **API Layer** | tRPC 11 with Superjson serialization |
| **Backend Runtime** | Node.js 22, Express 4 |
| **Database** | TiDB (MySQL-compatible), Drizzle ORM |
| **Object Storage** | AWS S3 |
| **Authentication** | Manus OAuth |
| **LLM Integration** | Manus Forge API |
| **Experiment Execution** | Node.js/TypeScript deterministic analysis engine, Chart.js, csv-parse, XLSX |
| **PDF Generation** | PDFKit |
| **Real-Time Updates** | Server-Sent Events (SSE) |
| **Build Tool** | Vite 7, esbuild |
| **Testing** | Vitest |
| **Package Manager** | pnpm |

---

## Data File Upload & Analysis

Auto Research supports uploading structured data files for automated analysis within the research pipeline. When datasets are attached to a pipeline run, the system performs the following workflow:

1. **Upload & Parse** — Files are split into 8MB chunks and uploaded through tRPC mutations (`datasets.uploadChunk`, `datasets.assembleChunks`, `datasets.registerFile`). The server then detects file format and extracts metadata including column names, row counts, and data types. Supported formats include CSV, Excel (.xlsx/.xls), Stata (.dta), JSON, and TSV.

2. **Schema Extraction** — During the experiment code generation stage (Stage 9), the pipeline retrieves all attached dataset files and constructs a detailed schema description including column names, data types, sample values, and basic statistics.

3. **Analysis Planning** — The LLM receives the dataset schema along with the research topic, hypothesis, and methodology to propose executable analyses. The pipeline then constrains that plan to methods supported by the deterministic runner.

4. **Deterministic Execution** — The server runs validated analysis routines directly in TypeScript, including descriptive statistics, correlation, regression, robust OLS, panel fixed effects, difference-in-differences, event study, synthetic control, and specialised chart generation.

5. **Result Integration** — Generated charts are uploaded to S3 as pipeline artifacts. Statistical metrics, econometric diagnostics, and table data are passed to the paper writing stages (Stage 18) where they are incorporated into the paper body with proper figure numbering, equations, and table formatting.

The current specialised figure catalogue includes coefficient interval plots, residual-vs-fitted plots, parallel-trends plots, event-study trajectories, synthetic-control path plots, synthetic-control gap plots, and donor-weight charts in addition to the standard descriptive visualisations.

---

## Conference Templates

The platform supports formatting papers according to major conference submission guidelines:

| Template | Conference | Document Class |
|---|---|---|
| NeurIPS | Neural Information Processing Systems | `neurips` |
| ICML | International Conference on Machine Learning | `icml` |
| ICLR | International Conference on Learning Representations | `iclr` |
| ACL | Association for Computational Linguistics | `acl` |
| AAAI | Association for the Advancement of AI | `aaai` |
| CVPR | Computer Vision and Pattern Recognition | `cvpr` |
| EMNLP | Empirical Methods in NLP | `emnlp` |
| General | General academic paper format | `article` |

---

## Literature Data Sources

The literature search module queries five academic databases in parallel and deduplicates results by DOI and title similarity:

| Source | Type | Coverage |
|---|---|---|
| **arXiv** | Preprint server | Computer science, physics, mathematics, and more |
| **Semantic Scholar** | AI-powered academic search | 200M+ papers across all fields |
| **Springer** | Academic publisher | Journals, books, and conference proceedings |
| **PubMed** | Biomedical database | Life sciences and biomedical literature |
| **CrossRef** | Metadata registry | DOI-based metadata for 150M+ records |

---

## Getting Started

### Prerequisites

The application requires Node.js 22+ and pnpm. Python is no longer required for the default deterministic dataset-analysis path.

### Installation

```bash
# Clone the repository
git clone https://github.com/tomoto0/auto-research.git
cd auto-research

# Install dependencies
pnpm install

# Run database migrations
pnpm run db:push

# Start development server
pnpm run dev
```

### Running Tests

```bash
pnpm test
```

The test suite covers authentication, pipeline operations, literature search integration, PDF generation, dataset upload, and deterministic experiment execution.

---

## Project Structure

```
auto-research/
├── client/                    # Frontend application
│   ├── src/
│   │   ├── pages/             # Page components (Home, Dashboard, RunDetail, etc.)
│   │   ├── components/        # Reusable UI components (shadcn/ui)
│   │   ├── contexts/          # React contexts
│   │   ├── hooks/             # Custom hooks
│   │   ├── lib/trpc.ts        # React tRPC client binding
│   │   ├── lib/chunked-upload.ts # Chunked dataset upload utility
│   │   ├── App.tsx            # Routes & layout
│   │   └── index.css          # Global styles & theme
│   └── index.html             # HTML template with OGP meta tags
├── server/
│   ├── _core/                 # Framework plumbing (OAuth, context, LLM, etc.)
│   ├── routers.ts             # tRPC procedures
│   ├── db.ts                  # Database query helpers
│   ├── pipeline-engine.ts     # 23-stage pipeline state machine
│   ├── experiment-runner.ts   # Deterministic statistics/econometrics runner
│   ├── literature.ts          # Multi-source academic search
│   ├── pdf-generator.ts       # Markdown-to-PDF converter
│   ├── upload-procedures.ts   # tRPC chunked upload procedures
│   ├── storage.ts             # S3 proxy helper utilities
│   └── *.test.ts              # Vitest test files
├── drizzle/
│   ├── schema.ts              # Database schema (Drizzle ORM)
│   └── *.sql                  # Migration files
├── shared/
│   └── pipeline.ts            # Shared types & constants
└── package.json
```

---

## Environment Variables

The application relies on platform-injected environment variables for database connectivity, authentication, LLM access, and external API keys. Key variables include:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | MySQL/TiDB connection string |
| `JWT_SECRET` | Session cookie signing secret |
| `VITE_APP_ID` | Manus OAuth application ID |
| `OAUTH_SERVER_URL` | Manus OAuth backend URL |
| `BUILT_IN_FORGE_API_URL` | Manus Forge API endpoint (LLM, storage, etc.) |
| `BUILT_IN_FORGE_API_KEY` | Server-side Forge API bearer token |
| `SEMANTIC_SCHOLAR_API_KEY` | Semantic Scholar API key |
| `SPRINGER_API_KEY` | Springer Nature API key |

---

## License

This project is licensed under the MIT License.
