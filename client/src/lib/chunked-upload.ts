/**
 * Chunked S3 Proxy Upload utility.
 * Splits large files into 8MB chunks and uploads each chunk to S3 via tRPC mutations.
 * Each chunk is base64-encoded and sent via datasets.uploadChunk mutation.
 * After all chunks are uploaded, calls datasets.registerFile to save metadata + parse preview.
 *
 * This approach:
 * - Bypasses reverse proxy body size limits (each chunk < 10MB)
 * - Avoids server memory accumulation (each chunk is processed independently)
 * - Survives server restarts (chunks already in S3 are safe)
 * - Provides real upload progress tracking
 * - Uses tRPC for automatic auth via ctx.user (no manual userId headers)
 */

import { trpcVanilla } from "./trpc-client";

const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB per chunk
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;
const MULTIPART_KEY_SUFFIX = "/parts";

export interface ChunkedUploadProgress {
  phase: "initiating" | "uploading" | "completing";
  chunkIndex: number;
  totalChunks: number;
  bytesUploaded: number;
  totalBytes: number;
  percent: number;
}

export interface ChunkedUploadResult {
  success: boolean;
  file?: {
    id: number;
    originalName: string;
    fileUrl: string;
    fileType: string;
    sizeBytes: number;
    columnNames: string[] | null;
    rowCount: number | null;
    preview: string | null;
  };
  error?: string;
}

function extractMessageFromUnknown(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Error) return value.message;
  if (Array.isArray(value)) {
    const joined = value.map(v => extractMessageFromUnknown(v)).filter(Boolean).join(" ");
    return joined || null;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return (
      extractMessageFromUnknown(obj.message) ||
      extractMessageFromUnknown(obj.data) ||
      extractMessageFromUnknown(obj.error) ||
      null
    );
  }
  return null;
}

function normaliseUploadError(err: unknown, fallback: string): string {
  const message = extractMessageFromUnknown(err) || fallback;
  if (message.includes("Unexpected token 'S'") || message.includes('"Service Unavailable" is not valid JSON')) {
    return "Storage service is temporarily unavailable. Please retry this upload.";
  }
  return message;
}

function generateId(len = 12): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  for (let i = 0; i < len; i++) result += chars[arr[i] % chars.length];
  return result;
}

/** Convert a Blob to a base64 string (chunked to avoid call stack limits) */
async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  // Process in 32KB chunks to avoid call stack size limits with btoa
  const BTOA_CHUNK = 32768;
  let binary = "";
  for (let i = 0; i < bytes.length; i += BTOA_CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + BTOA_CHUNK, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(binary);
}

/** Retry wrapper for tRPC mutations. Retries on server errors, not on client errors. */
async function mutateWithRetry<T>(
  fn: () => Promise<T>,
  retries = MAX_RETRIES
): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      // Don't retry on client-side errors (BAD_REQUEST, PAYLOAD_TOO_LARGE, etc.)
      const code = (err as any)?.data?.code;
      if (code === "BAD_REQUEST" || code === "PAYLOAD_TOO_LARGE" || code === "UNPROCESSABLE_CONTENT") {
        throw new Error(normaliseUploadError(err, "Upload request failed"));
      }
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, RETRY_DELAY * (attempt + 1)));
        continue;
      }
      throw new Error(normaliseUploadError(err, "Upload request failed"));
    }
  }
  throw new Error("Max retries exceeded");
}

/**
 * Upload file via chunked S3 proxy, then register with server.
 */
export async function chunkedUpload(
  file: File,
  onProgress?: (progress: ChunkedUploadProgress) => void
): Promise<ChunkedUploadResult> {
  const totalBytes = file.size;
  const MAX_FILE_SIZE = 250 * 1024 * 1024;

  if (totalBytes > MAX_FILE_SIZE) {
    return { success: false, error: "File too large (max 250MB)" };
  }

  const totalChunks = Math.ceil(totalBytes / CHUNK_SIZE);
  const uploadId = generateId();
  const fileMime = file.type || "application/octet-stream";

  // Phase 1: Initiating
  onProgress?.({
    phase: "initiating",
    chunkIndex: 0,
    totalChunks,
    bytesUploaded: 0,
    totalBytes,
    percent: 0,
  });

  // Phase 2: Upload chunks sequentially via tRPC to S3
  let bytesUploaded = 0;
  let lastChunkUrl = "";

  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, totalBytes);
    const chunk = file.slice(start, end);

    onProgress?.({
      phase: "uploading",
      chunkIndex: i,
      totalChunks,
      bytesUploaded,
      totalBytes,
      percent: Math.round((bytesUploaded / totalBytes) * 90),
    });

    // Each chunk gets its own S3 key (for multi-chunk files, use part suffix)
    const fileKey = totalChunks === 1
      ? `datasets/${uploadId}/${file.name}`
      : `datasets/${uploadId}/parts/${String(i).padStart(4, "0")}`;

    const chunkBase64 = await blobToBase64(chunk);

    try {
      const chunkResult = await mutateWithRetry(() =>
        trpcVanilla.datasets.uploadChunk.mutate({ fileKey, fileMime, chunkBase64 })
      );
      lastChunkUrl = chunkResult.url;
    } catch (err: unknown) {
      return {
        success: false,
        error: normaliseUploadError(err, `Chunk ${i + 1}/${totalChunks} failed`),
      };
    }

    bytesUploaded = end;
  }

  // Phase 3: If multi-chunk, we need to assemble on server side
  // For single chunk, the file is already complete in S3
  onProgress?.({
    phase: "completing",
    chunkIndex: totalChunks,
    totalChunks,
    bytesUploaded: totalBytes,
    totalBytes,
    percent: 92,
  });

  let finalFileUrl: string;
  let finalFileKey: string;

  if (totalChunks === 1) {
    // Single chunk - file is already complete in S3
    finalFileUrl = lastChunkUrl;
    finalFileKey = `datasets/${uploadId}/${file.name}`;
  } else {
    // Multi-chunk - call server to assemble parts
    try {
      const assembleResult = await mutateWithRetry(() =>
        trpcVanilla.datasets.assembleChunks.mutate({
          uploadId,
          fileName: file.name,
          fileMime,
          totalChunks,
          totalSize: totalBytes,
        })
      );
      finalFileUrl = assembleResult.fileUrl;
      finalFileKey = assembleResult.fileKey;
    } catch (err: unknown) {
      return { success: false, error: normaliseUploadError(err, "Assembly failed") };
    }
  }

  // Phase 4: Register with server (small JSON, no file data)
  try {
    const result = await mutateWithRetry(() =>
      trpcVanilla.datasets.registerFile.mutate({
        fileName: file.name,
        fileMime,
        fileKey: finalFileKey,
        fileUrl: finalFileUrl,
        sizeBytes: totalBytes,
        ...(finalFileKey.endsWith(MULTIPART_KEY_SUFFIX) ? { multipartTotalChunks: totalChunks } : {}),
      })
    );

    onProgress?.({
      phase: "completing",
      chunkIndex: totalChunks,
      totalChunks,
      bytesUploaded: totalBytes,
      totalBytes,
      percent: 100,
    });

    return { success: true, file: result.file };
  } catch (err: unknown) {
    return { success: false, error: normaliseUploadError(err, "Registration failed") };
  }
}
