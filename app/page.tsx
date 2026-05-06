"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addStoredResult,
  clearExpiredResults,
  clearStoredResults,
  deleteStoredResult,
  getStoredResults,
  type StoredResult
} from "../lib/idb";

type CropBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type ApiResult = {
  id: string;
  filename: string;
  mime: string;
  width: number;
  height: number;
  dataUrl: string;
  cropBox: CropBox;
  confidence: number;
};

type UploadStatus = {
  text: string;
  kind: "idle" | "loading" | "success" | "error";
};

type IconProps = {
  className?: string;
};

const TEN_MINUTES = 10 * 60 * 1000;
const RESULT_CACHE_VERSION = 3;
const CONTENT_SOURCE_KEY_PATTERN = /^\d+:[a-f0-9]{64}$/;

function isContentSourceKey(sourceKey?: string): sourceKey is string {
  return Boolean(sourceKey && CONTENT_SOURCE_KEY_PATTERN.test(sourceKey));
}

async function createSourceKey(file: File) {
  const buffer = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  const hashText = Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${file.size}:${hashText}`;
}

function mergeUniqueResults(newItems: StoredResult[], currentItems: StoredResult[]) {
  const seenSourceKeys = new Set<string>();
  const seenIds = new Set<string>();
  const validItems = [...newItems, ...currentItems].filter((item) => item.cacheVersion === RESULT_CACHE_VERSION);
  const contentFilenames = new Set(validItems.filter((item) => isContentSourceKey(item.sourceKey)).map((item) => item.filename));
  const merged: StoredResult[] = [];

  for (const item of validItems) {
    if (isContentSourceKey(item.sourceKey)) {
      if (seenSourceKeys.has(item.sourceKey)) continue;
      seenSourceKeys.add(item.sourceKey);
    } else if (contentFilenames.has(item.filename)) {
      continue;
    } else if (seenIds.has(item.id)) {
      continue;
    }

    seenIds.add(item.id);
    merged.push(item);
  }

  return merged;
}

function TrashIcon({ className }: IconProps) {
  return (
    <svg className={className} aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path d="M8.25 7.25h7.5M10.1 4.75h3.8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <path
        d="M7.65 7.25l.66 10.92a2.35 2.35 0 0 0 2.34 2.18h2.7a2.35 2.35 0 0 0 2.34-2.18l.66-10.92"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M10.45 10.55v6.2M13.55 10.55v6.2" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const isProcessingRef = useRef(false);
  const resultsRef = useRef<StoredResult[]>([]);
  const [results, setResults] = useState<StoredResult[]>([]);
  const [status, setStatus] = useState<UploadStatus>({ text: "暂无结果", kind: "idle" });
  const [isDragging, setIsDragging] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [isProgressLeaving, setIsProgressLeaving] = useState(false);

  useEffect(() => {
    resultsRef.current = results;
  }, [results]);

  useEffect(() => {
    void clearExpiredResults().then(loadStoredResults);

    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }

    if ("serviceWorker" in navigator && process.env.NODE_ENV !== "production") {
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        registrations.forEach((registration) => {
          registration.unregister().catch(() => undefined);
        });
      });
      caches.keys().then((keys) => {
        keys.forEach((key) => {
          caches.delete(key).catch(() => undefined);
        });
      });
    }

    const timer = window.setInterval(() => {
      void clearExpiredResults().then(loadStoredResults);
    }, 30 * 1000);

    return () => window.clearInterval(timer);
  }, []);

  const loadStoredResults = async () => {
    const stored = await getStoredResults();
    setResults(mergeUniqueResults(stored, []));
    if (mergeUniqueResults(stored, []).length === 0) {
      setStatus((current) => (current.kind === "loading" ? current : { text: "暂无结果", kind: "idle" }));
    }
  };

  const processFiles = useCallback(async (files: FileList | File[]) => {
    if (isProcessingRef.current) {
      setStatus({ text: "正在处理，请稍等", kind: "loading" });
      return;
    }

    const imageFiles = Array.from(files).filter((file) => file.type.startsWith("image/"));

    if (imageFiles.length === 0) {
      setStatus({ text: "请选择图片文件", kind: "error" });
      return;
    }

    if (imageFiles.length > 10) {
      setStatus({ text: "一次最多选择 10 张图片", kind: "error" });
      return;
    }

    isProcessingRef.current = true;
    const processingStartedAt = performance.now();
    setStatus({ text: `正在处理 ${imageFiles.length} 张图片`, kind: "loading" });

    try {
      const keyedFiles = await Promise.all(
        imageFiles.map(async (file) => ({
          file,
          sourceKey: await createSourceKey(file)
        }))
      );
      const existingSourceKeys = new Set(resultsRef.current.map((item) => item.sourceKey).filter(isContentSourceKey));
      const seenSourceKeys = new Set<string>();
      const uploadItems = keyedFiles.filter((item) => {
        if (seenSourceKeys.has(item.sourceKey) || existingSourceKeys.has(item.sourceKey)) return false;
        seenSourceKeys.add(item.sourceKey);
        return true;
      });

      if (uploadItems.length === 0) {
        setStatus({ text: "图片已在结果中", kind: "success" });
        return;
      }

      const formData = new FormData();
      const sourceKeys = uploadItems.map((item) => item.sourceKey);
      for (const { file } of uploadItems) {
        formData.append("images", file, file.name);
      }

      const response = await fetch("/api/process", {
        method: "POST",
        body: formData
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error || "处理失败");
      }

      const now = Date.now();
      const processed: StoredResult[] = payload.results.map((item: ApiResult, index: number) => ({
        ...item,
        sourceKey: sourceKeys[index],
        cacheVersion: RESULT_CACHE_VERSION,
        createdAt: now,
        expiresAt: now + TEN_MINUTES
      }));

      for (const item of processed) {
        await addStoredResult(item);
      }

      const elapsed = performance.now() - processingStartedAt;
      if (elapsed < 1450) {
        await new Promise((resolve) => window.setTimeout(resolve, 1450 - elapsed));
      }

      setResults((current) => mergeUniqueResults(processed, current));
      setStatus({ text: "处理完成", kind: "success" });
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : "处理失败", kind: "error" });
    } finally {
      isProcessingRef.current = false;
      if (inputRef.current) {
        inputRef.current.value = "";
      }
    }
  }, []);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
      if (files.length > 0) {
        event.preventDefault();
        void processFiles(files);
      }
    };

    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [processFiles]);

  useEffect(() => {
    if (status.kind === "idle" || status.kind === "loading") return undefined;

    const timer = window.setTimeout(() => {
      setStatus({ text: "暂无结果", kind: "idle" });
    }, 2200);

    return () => window.clearTimeout(timer);
  }, [status.kind, status.text]);

  useEffect(() => {
    if (status.kind === "loading") {
      setShowProgress(true);
      setIsProgressLeaving(false);
      return undefined;
    }

    if (!showProgress) return undefined;

    setIsProgressLeaving(true);
    const timer = window.setTimeout(() => {
      setShowProgress(false);
      setIsProgressLeaving(false);
    }, 620);

    return () => window.clearTimeout(timer);
  }, [showProgress, status.kind]);

  const handleDelete = async (id: string) => {
    await deleteStoredResult(id);
    setResults((current) => current.filter((item) => item.id !== id));
  };

  const clearAllCache = async () => {
    await clearStoredResults();
    setResults([]);
    setStatus({ text: "缓存已清空", kind: "success" });

    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }

    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }

    localStorage.clear();
    sessionStorage.clear();
  };

  const saveImage = async (item: StoredResult) => {
    const link = document.createElement("a");
    const extension = item.mime.includes("png") ? "png" : "jpg";
    const baseName = item.filename.replace(/\.[^.]+$/, "") || "image";
    const response = await fetch(item.dataUrl);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);

    try {
      link.href = url;
      link.download = `${baseName}-cut.${extension}`;
      document.body.appendChild(link);
      link.click();
    } finally {
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  };

  const statusClass = useMemo(() => {
    if (status.kind === "error") return "text-[var(--danger)] bg-[var(--danger-soft)]";
    if (status.kind === "success") return "text-[var(--success)] bg-[var(--success-soft)]";
    if (status.kind === "loading") return "text-[var(--primary)] bg-[var(--primary-soft)]";
    return "text-[var(--muted)] bg-transparent";
  }, [status.kind]);

  const isProcessing = status.kind === "loading";
  const hasResultStatus = status.kind !== "idle";

  return (
    <main className="min-h-dvh overflow-hidden px-5 pb-[calc(112px+env(safe-area-inset-bottom))] pt-[calc(42px+env(safe-area-inset-top))] sm:px-6 lg:px-8 lg:pb-16 lg:pt-14">
      <div className="mx-auto flex w-full max-w-[42rem] flex-col gap-7 lg:gap-8">
        <header className="pt-3 text-center lg:pt-0">
          <h1 className="mx-auto max-w-[15ch] text-[2rem] font-bold leading-[1.12] tracking-normal text-[var(--foreground)] sm:max-w-none sm:text-[2.6rem] lg:text-5xl">
            小红书截图剥离图片工具
          </h1>
          <p className="mt-3 text-[1rem] leading-7 text-[var(--muted)]">
            专门为小红书 UI 进行识别截图，方便提取素材
          </p>
        </header>

        <div className="flex flex-col gap-8">
          <section
            className={[
              "liquid-card liquid-upload-card rounded-[26px] border bg-[var(--glass-card)] p-4 shadow-[var(--shadow-card)] backdrop-blur-2xl transition duration-200 sm:p-5",
              isDragging ? "border-[var(--primary)] ring-4 ring-[var(--primary-soft)]" : "border-[var(--border)]"
            ].join(" ")}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setIsDragging(false);
              void processFiles(event.dataTransfer.files);
            }}
          >
            <button
              type="button"
              className="liquid-dropzone liquid-upload-empty group flex min-h-56 w-full flex-col items-center justify-center rounded-[22px] border border-dashed border-[var(--dash-border)] bg-[var(--glass-surface)] px-5 py-9 text-center transition duration-200 hover:bg-[var(--glass-surface-active)] focus:outline-none focus-visible:ring-4 focus-visible:ring-[var(--focus-ring)] active:scale-[0.99] lg:min-h-[17.5rem]"
              onClick={() => inputRef.current?.click()}
              aria-label="选择图片上传"
            >
              <span className="text-[1.32rem] font-medium leading-8 text-[var(--foreground)]">选择图片</span>
              <span className="mt-3 max-w-xs text-[0.95rem] leading-6 text-[var(--muted)]">支持单张或多张截图，也可以拖拽上传</span>
            </button>
            <input
              ref={inputRef}
              className="hidden"
              type="file"
              accept="image/*"
              multiple
              onChange={(event) => {
                if (event.target.files) {
                  void processFiles(event.target.files);
                }
              }}
            />
            {showProgress ? (
              <div className={`processing-progress mt-4 overflow-hidden rounded-full bg-[var(--surface)] ${isProgressLeaving ? "processing-progress-leaving" : ""}`} aria-hidden="true">
                <div className="processing-progress-bar h-full rounded-full" />
              </div>
            ) : null}
          </section>

          <section className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <h2 className="text-[1.55rem] font-bold tracking-normal text-[var(--foreground)] sm:text-[1.7rem]">处理结果</h2>
              <div className="flex min-w-0 flex-1 items-center justify-end gap-2 text-[var(--muted)]">
                {hasResultStatus ? (
                  <p
                    key={`${status.kind}-${status.text}`}
                    className={`truncate rounded-full px-3 py-1 text-sm font-medium transition-colors ${status.kind === "loading" ? "result-status-pill-live" : "result-status-pill"} ${statusClass}`}
                    aria-live="polite"
                  >
                    {status.text}
                  </p>
                ) : null}
                <button
                  type="button"
                  className="flex min-h-10 min-w-10 items-center justify-center rounded-full text-[var(--muted)] opacity-80 transition hover:bg-[var(--glass-surface)] hover:opacity-100 focus:outline-none focus-visible:ring-4 focus-visible:ring-[var(--focus-ring)] active:bg-[var(--surface-active)]"
                  onClick={() => {
                    void clearAllCache();
                  }}
                  aria-label="清空缓存"
                >
                  <TrashIcon className="h-[22px] w-[22px]" />
                </button>
                <span className="min-w-10 text-right text-base font-medium text-[var(--muted)]">{results.length} 张</span>
              </div>
            </div>

            {results.length === 0 ? (
              <div className="liquid-card liquid-result-card rounded-[26px] border border-[var(--glass-line)] bg-[var(--glass-card)] p-4 shadow-[var(--shadow-card)] backdrop-blur-2xl sm:p-5">
                <div className="liquid-result-empty flex min-h-40 flex-col items-center justify-center rounded-[22px] border border-[var(--glass-line)] bg-[var(--result-glass-surface)] px-6 py-9 text-center lg:min-h-[13.5rem]">
                  <p className="text-[1rem] leading-7 text-[var(--muted)]">裁切结果会显示在这里</p>
                </div>
              </div>
            ) : (
              <div className="grid gap-4 xl:grid-cols-2">
                {results.map((item) => (
                  <article key={item.id} className="liquid-card rounded-[26px] border border-[var(--border)] bg-[var(--glass-card)] p-4 shadow-[var(--shadow-card)] backdrop-blur-2xl">
                    <div className="flex flex-col gap-1">
                      <h3 className="break-words text-base font-semibold text-[var(--foreground)]">{item.filename}</h3>
                      <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--muted)]">
                        <span>
                          {item.width} x {item.height}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className={item.confidence >= 0.8 ? "text-[var(--success)]" : "text-[var(--warning)]"}>
                          {item.confidence >= 0.8 ? "高可信" : "需检查"} {Math.round(item.confidence * 100)}%
                        </span>
                      </div>
                    </div>

                    <div className="mt-4 overflow-hidden rounded-[20px] border border-[var(--border)] bg-[var(--surface)]">
                      <img className="h-auto w-full" src={item.dataUrl} alt={`${item.filename} 裁切预览`} />
                    </div>

                    <div className="mt-4 grid grid-cols-2 gap-3">
                      <button
                        type="button"
                        className="min-h-12 rounded-[14px] bg-[var(--primary)] px-4 text-sm font-semibold text-[var(--primary-foreground)] transition hover:bg-[var(--primary-active)] focus:outline-none focus-visible:ring-4 focus-visible:ring-[var(--focus-ring)] active:scale-[0.98]"
                        onClick={() => {
                          void saveImage(item);
                        }}
                      >
                        保存图片
                      </button>
                      <button
                        type="button"
                        className="min-h-12 rounded-[14px] bg-[var(--surface)] px-4 text-sm font-semibold text-[var(--foreground)] transition hover:bg-[var(--surface-active)] focus:outline-none focus-visible:ring-4 focus-visible:ring-[var(--focus-ring)] active:scale-[0.98]"
                        onClick={() => void handleDelete(item.id)}
                      >
                        删除
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>

        <p className="px-1 text-center text-xs leading-6 text-[var(--muted)] opacity-80">
          免责声明：提取素材如涉及原作者隐私或相关权益，请自行获得授权；因使用本工具产生的侵权或隐私问题，本工具不承担责任。
        </p>
      </div>
    </main>
  );
}
