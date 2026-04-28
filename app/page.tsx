"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addStoredResult,
  clearExpiredResults,
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

const TEN_MINUTES = 10 * 60 * 1000;

function createSourceKey(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function mergeUniqueResults(newItems: StoredResult[], currentItems: StoredResult[]) {
  const seenSourceKeys = new Set<string>();
  const seenIds = new Set<string>();
  const newFilenames = new Set(newItems.map((item) => item.filename));
  const merged: StoredResult[] = [];

  for (const item of [...newItems, ...currentItems]) {
    if (item.sourceKey) {
      if (seenSourceKeys.has(item.sourceKey)) continue;
      seenSourceKeys.add(item.sourceKey);
    } else if (currentItems.includes(item) && newFilenames.has(item.filename)) {
      continue;
    } else if (seenIds.has(item.id)) {
      continue;
    }

    seenIds.add(item.id);
    merged.push(item);
  }

  return merged;
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [results, setResults] = useState<StoredResult[]>([]);
  const [status, setStatus] = useState<UploadStatus>({ text: "暂无结果", kind: "idle" });
  const [isDragging, setIsDragging] = useState(false);

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
    if (stored.length === 0) {
      setStatus((current) => (current.kind === "loading" ? current : { text: "暂无结果", kind: "idle" }));
    }
  };

  const processFiles = useCallback(async (files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter((file) => file.type.startsWith("image/"));

    if (imageFiles.length === 0) {
      setStatus({ text: "请选择图片文件", kind: "error" });
      return;
    }

    setStatus({ text: "正在处理...", kind: "loading" });

    const formData = new FormData();
    const sourceKeys = imageFiles.map(createSourceKey);
    for (const file of imageFiles) {
      formData.append("images", file, file.name);
    }

    try {
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
        createdAt: now,
        expiresAt: now + TEN_MINUTES
      }));

      for (const item of processed) {
        await addStoredResult(item);
      }

      setResults((current) => mergeUniqueResults(processed, current));
      setStatus({ text: "处理完成", kind: "success" });
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : "处理失败", kind: "error" });
    } finally {
      if (inputRef.current) {
        inputRef.current.value = "";
      }
    }
  }, []);

  const handleDelete = async (id: string) => {
    await deleteStoredResult(id);
    setResults((current) => current.filter((item) => item.id !== id));
  };

  const saveImage = (item: StoredResult) => {
    const link = document.createElement("a");
    const extension = item.mime.includes("png") ? "png" : "jpg";
    const baseName = item.filename.replace(/\.[^.]+$/, "") || "image";
    link.href = item.dataUrl;
    link.download = `${baseName}-cut.${extension}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const statusClass = useMemo(() => {
    if (status.kind === "error") return "text-[var(--danger)]";
    if (status.kind === "success") return "text-[var(--success)]";
    if (status.kind === "loading") return "text-[var(--foreground)]";
    return "text-[var(--muted)]";
  }, [status.kind]);

  return (
    <main className="min-h-screen px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-[calc(24px+env(safe-area-inset-top))]">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
        <header className="pt-3">
          <h1 className="text-3xl font-semibold tracking-normal text-[var(--foreground)]">截图剥离图片工具</h1>
          <p className="mt-2 text-base leading-6 text-[var(--muted)]">上传截图，自动裁切中间图片区域</p>
        </header>

        <section
          className={[
            "rounded-3xl border bg-[var(--card)] p-5 shadow-sm transition-colors",
            isDragging ? "border-[var(--foreground)]" : "border-[var(--border)]"
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
            className="flex min-h-44 w-full flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--border-strong)] bg-[var(--surface)] px-4 py-8 text-center active:bg-[var(--surface-active)]"
            onClick={() => inputRef.current?.click()}
          >
            <span className="text-lg font-medium text-[var(--foreground)]">选择图片</span>
            <span className="mt-2 max-w-xs text-sm leading-5 text-[var(--muted)]">支持单张或多张截图，也可以拖拽上传</span>
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
          <p className={`mt-4 min-h-6 text-sm ${statusClass}`}>{status.text}</p>
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-[var(--foreground)]">处理结果</h2>
            <span className="text-sm text-[var(--muted)]">{results.length} 张</span>
          </div>

          {results.length === 0 ? (
            <div className="rounded-3xl border border-[var(--border)] bg-[var(--card)] px-5 py-10 text-center text-sm text-[var(--muted)] shadow-sm">
              暂无结果
            </div>
          ) : (
            results.map((item) => (
              <article key={item.id} className="rounded-3xl border border-[var(--border)] bg-[var(--card)] p-4 shadow-sm">
                <div className="flex flex-col gap-1">
                  <h3 className="break-words text-base font-medium text-[var(--foreground)]">{item.filename}</h3>
                  <p className="text-sm text-[var(--muted)]">
                    {item.width} x {item.height} · 置信度 {Math.round(item.confidence * 100)}%
                  </p>
                </div>

                <div className="mt-4 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
                  <img className="h-auto w-full" src={item.dataUrl} alt={`${item.filename} 裁切预览`} />
                </div>

                <div className="mt-4 grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    className="min-h-11 rounded-2xl bg-[var(--primary)] px-4 text-sm font-medium text-[var(--primary-foreground)] active:bg-[var(--primary-active)]"
                    onClick={() => saveImage(item)}
                  >
                    保存图片
                  </button>
                  <button
                    type="button"
                    className="min-h-11 rounded-2xl bg-[var(--surface)] px-4 text-sm font-medium text-[var(--foreground)] active:bg-[var(--surface-active)]"
                    onClick={() => void handleDelete(item.id)}
                  >
                    删除
                  </button>
                </div>
              </article>
            ))
          )}
        </section>
      </div>
    </main>
  );
}
