import { NextResponse } from "next/server";
import { cropXhsScreenshot } from "../../../lib/crop";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_FILES = 10;
const MAX_FILE_SIZE = 12 * 1024 * 1024;
const CONCURRENCY = 3;

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function run() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex++;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const images = formData.getAll("images").filter((item): item is File => item instanceof File);

    if (images.length === 0) {
      return NextResponse.json({ error: "没有收到 images 字段中的图片文件" }, { status: 400 });
    }

    if (images.length > MAX_FILES) {
      return NextResponse.json({ error: `一次最多处理 ${MAX_FILES} 张图片` }, { status: 400 });
    }

    const results = await mapWithConcurrency(images, CONCURRENCY, async (image) => {
      if (!image.type.startsWith("image/")) {
        throw new Error(`${image.name || "文件"} 不是图片格式`);
      }

      if (image.size > MAX_FILE_SIZE) {
        throw new Error(`${image.name || "图片"} 超过 12MB 限制`);
      }

      const buffer = Buffer.from(await image.arrayBuffer());
      return cropXhsScreenshot(buffer, image.name || "image");
    });

    return NextResponse.json({ results });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "图片处理失败，请换一张截图重试" },
      { status: 500 }
    );
  }
}
