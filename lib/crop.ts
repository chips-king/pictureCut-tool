import sharp from "sharp";

type Rgb = [number, number, number];

export type CropBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type CropResult = {
  id: string;
  filename: string;
  mime: string;
  width: number;
  height: number;
  dataUrl: string;
  cropBox: CropBox;
  confidence: number;
  debug?: {
    fallback: boolean;
    detector: string;
    background: Rgb[];
    candidates: Array<{
      detector: string;
      score: number;
      confidence: number;
      backgroundRatio?: number;
      edgeScore?: number;
      contentDensity?: number;
      cropBox: CropBox;
    }>;
  };
};

type Segment = {
  start: number;
  end: number;
  score: number;
};

type AnalysisImage = {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
  scaleX: number;
  scaleY: number;
  originalWidth: number;
  originalHeight: number;
};

type Candidate = {
  detector: string;
  box: CropBox;
  score: number;
  confidence: number;
  fallback?: boolean;
  metrics?: CandidateMetrics;
};

type CandidateMetrics = {
  backgroundRatio: number;
  edgeScore: number;
  contentDensity: number;
};

type DetectionResult = {
  box: CropBox;
  confidence: number;
  detector: string;
  fallback: boolean;
  background: Rgb[];
  candidates: Array<{
    detector: string;
    score: number;
    confidence: number;
    backgroundRatio?: number;
    edgeScore?: number;
    contentDensity?: number;
    cropBox: CropBox;
  }>;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function rgbDistance(a: Rgb, b: Rgb) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function luminance(color: Rgb) {
  return color[0] * 0.299 + color[1] * 0.587 + color[2] * 0.114;
}

function pixelAt(image: AnalysisImage, x: number, y: number): Rgb {
  const safeX = clamp(Math.round(x), 0, image.width - 1);
  const safeY = clamp(Math.round(y), 0, image.height - 1);
  const index = (safeY * image.width + safeX) * image.channels;
  return [image.data[index] ?? 0, image.data[index + 1] ?? 0, image.data[index + 2] ?? 0];
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function smooth(values: number[], radius: number) {
  const output = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let count = 0;
    for (let offset = -radius; offset <= radius; offset++) {
      const index = i + offset;
      if (index >= 0 && index < values.length) {
        sum += values[index];
        count++;
      }
    }
    output[i] = sum / count;
  }
  return output;
}

function findSegments(values: number[], threshold: number, minLength: number, startLimit = 0, endLimit = values.length - 1) {
  const segments: Segment[] = [];
  let start = -1;
  let score = 0;

  for (let i = startLimit; i <= endLimit; i++) {
    if ((values[i] ?? 0) >= threshold) {
      if (start < 0) {
        start = i;
        score = 0;
      }
      score += values[i] ?? 0;
    } else if (start >= 0) {
      if (i - start >= minLength) {
        segments.push({ start, end: i - 1, score });
      }
      start = -1;
      score = 0;
    }
  }

  if (start >= 0 && endLimit - start + 1 >= minLength) {
    segments.push({ start, end: endLimit, score });
  }

  return segments;
}

function estimateBackgroundPalette(image: AnalysisImage) {
  const samples: Rgb[] = [];
  const step = Math.max(1, Math.floor(Math.min(image.width, image.height) / 90));
  const cornerSize = Math.max(8, Math.floor(Math.min(image.width, image.height) * 0.04));

  const add = (x: number, y: number) => samples.push(pixelAt(image, x, y));

  for (let y = 0; y < image.height; y += step) {
    add(0, y);
    add(image.width - 1, y);
  }

  for (let x = 0; x < image.width; x += step) {
    add(x, 0);
    add(x, image.height - 1);
  }

  for (let y = 0; y < cornerSize; y += 2) {
    for (let x = 0; x < cornerSize; x += 2) {
      add(x, y);
      add(image.width - 1 - x, y);
      add(x, image.height - 1 - y);
      add(image.width - 1 - x, image.height - 1 - y);
    }
  }

  const buckets = new Map<string, { color: Rgb; count: number }>();
  for (const sample of samples) {
    const key = sample.map((value) => Math.round(value / 16) * 16).join(",");
    const existing = buckets.get(key);
    if (existing) {
      existing.count++;
    } else {
      buckets.set(key, { color: sample, count: 1 });
    }
  }

  const frequent = [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 4)
    .map((bucket) => bucket.color);

  const medianColor: Rgb = [
    Math.round(median(samples.map((item) => item[0]))),
    Math.round(median(samples.map((item) => item[1]))),
    Math.round(median(samples.map((item) => item[2])))
  ];

  return [medianColor, ...frequent].filter(
    (color, index, palette) => palette.findIndex((other) => rgbDistance(color, other) < 10) === index
  );
}

function nearestPaletteDistance(color: Rgb, palette: Rgb[]) {
  return Math.min(...palette.map((background) => rgbDistance(color, background)));
}

function isNearPalette(color: Rgb, palette: Rgb[], tolerance: number) {
  return nearestPaletteDistance(color, palette) <= tolerance;
}

function rowAverageColor(image: AnalysisImage, y: number, left = 0, right = image.width - 1): Rgb {
  const step = Math.max(1, Math.floor((right - left + 1) / 90));
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  for (let x = left; x <= right; x += step) {
    const color = pixelAt(image, x, y);
    r += color[0];
    g += color[1];
    b += color[2];
    count++;
  }

  return [r / count, g / count, b / count];
}

function colAverageColor(image: AnalysisImage, x: number, top = 0, bottom = image.height - 1): Rgb {
  const step = Math.max(1, Math.floor((bottom - top + 1) / 90));
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  for (let y = top; y <= bottom; y += step) {
    const color = pixelAt(image, x, y);
    r += color[0];
    g += color[1];
    b += color[2];
    count++;
  }

  return [r / count, g / count, b / count];
}

function buildSignals(image: AnalysisImage, palette: Rgb[]) {
  const tolerance = clamp(Math.min(image.width, image.height) / 18, 20, 42);
  const rowDiff = new Array<number>(image.height).fill(0);
  const colDiff = new Array<number>(image.width).fill(0);
  const rowDark = new Array<number>(image.height).fill(0);
  const colDark = new Array<number>(image.width).fill(0);
  const rowGradient = new Array<number>(image.height).fill(0);
  const colGradient = new Array<number>(image.width).fill(0);
  const step = Math.max(1, Math.floor(Math.min(image.width, image.height) / 650));

  for (let y = 0; y < image.height; y += step) {
    let diffCount = 0;
    let darkCount = 0;
    let rowSamples = 0;
    for (let x = 0; x < image.width; x += step) {
      const color = pixelAt(image, x, y);
      if (!isNearPalette(color, palette, tolerance)) diffCount++;
      if (luminance(color) < 26) darkCount++;
      rowSamples++;
      colDiff[x] += !isNearPalette(color, palette, tolerance) ? 1 : 0;
      colDark[x] += luminance(color) < 26 ? 1 : 0;
    }
    rowDiff[y] = diffCount / rowSamples;
    rowDark[y] = darkCount / rowSamples;
  }

  const sampledRows = Math.ceil(image.height / step);
  for (let x = 0; x < image.width; x++) {
    colDiff[x] = colDiff[x] / sampledRows;
    colDark[x] = colDark[x] / sampledRows;
  }

  for (let y = 1; y < image.height; y++) {
    rowGradient[y] = rgbDistance(rowAverageColor(image, y), rowAverageColor(image, y - 1)) / 255;
  }

  for (let x = 1; x < image.width; x++) {
    colGradient[x] = rgbDistance(colAverageColor(image, x), colAverageColor(image, x - 1)) / 255;
  }

  const fillSkipped = (values: number[]) => {
    for (let i = 1; i < values.length; i++) {
      if (values[i] === 0) values[i] = values[i - 1];
    }
    return values;
  };

  return {
    rowDiff: smooth(fillSkipped(rowDiff), Math.max(2, Math.floor(image.height * 0.006))),
    colDiff: smooth(fillSkipped(colDiff), Math.max(2, Math.floor(image.width * 0.008))),
    rowDark: smooth(fillSkipped(rowDark), Math.max(2, Math.floor(image.height * 0.004))),
    colDark: smooth(fillSkipped(colDark), Math.max(2, Math.floor(image.width * 0.004))),
    rowGradient: smooth(rowGradient, Math.max(1, Math.floor(image.height * 0.003))),
    colGradient: smooth(colGradient, Math.max(1, Math.floor(image.width * 0.003)))
  };
}

function darkRatioInRow(image: AnalysisImage, y: number, left = 0, right = image.width - 1, threshold = 30) {
  const safeLeft = clamp(left, 0, image.width - 1);
  const safeRight = clamp(right, safeLeft, image.width - 1);
  const step = Math.max(1, Math.floor((safeRight - safeLeft + 1) / 180));
  let dark = 0;
  let count = 0;

  for (let x = safeLeft; x <= safeRight; x += step) {
    const color = pixelAt(image, x, y);
    if (luminance(color) <= threshold) dark++;
    count++;
  }

  return count > 0 ? dark / count : 0;
}

function darkRatioInCol(image: AnalysisImage, x: number, top = 0, bottom = image.height - 1, threshold = 30) {
  const safeTop = clamp(top, 0, image.height - 1);
  const safeBottom = clamp(bottom, safeTop, image.height - 1);
  const step = Math.max(1, Math.floor((safeBottom - safeTop + 1) / 180));
  let dark = 0;
  let count = 0;

  for (let y = safeTop; y <= safeBottom; y += step) {
    const color = pixelAt(image, x, y);
    if (luminance(color) <= threshold) dark++;
    count++;
  }

  return count > 0 ? dark / count : 0;
}

function averageDarkRatioInRows(image: AnalysisImage, start: number, end: number) {
  const safeStart = clamp(start, 0, image.height - 1);
  const safeEnd = clamp(end, safeStart, image.height - 1);
  const step = Math.max(1, Math.floor((safeEnd - safeStart + 1) / 32));
  let sum = 0;
  let count = 0;

  for (let y = safeStart; y <= safeEnd; y += step) {
    sum += darkRatioInRow(image, y);
    count++;
  }

  return count > 0 ? sum / count : 0;
}

function averageDarkRatioInCols(image: AnalysisImage, start: number, end: number, top = 0, bottom = image.height - 1) {
  const safeStart = clamp(start, 0, image.width - 1);
  const safeEnd = clamp(end, safeStart, image.width - 1);
  const step = Math.max(1, Math.floor((safeEnd - safeStart + 1) / 32));
  let sum = 0;
  let count = 0;

  for (let x = safeStart; x <= safeEnd; x += step) {
    sum += darkRatioInCol(image, x, top, bottom);
    count++;
  }

  return count > 0 ? sum / count : 0;
}

function detectFastBlackMatte(image: AnalysisImage) {
  const rowDark = new Array<number>(image.height);
  for (let y = 0; y < image.height; y++) {
    rowDark[y] = darkRatioInRow(image, y);
  }

  const matteThreshold = 0.72;
  const contentThreshold = 0.52;
  const minBand = Math.floor(image.height * 0.08);
  const minContentHeight = Math.floor(image.height * 0.16);
  const stableRows = Math.max(2, Math.floor(image.height * 0.006));

  const isContentRow = (index: number) => {
    let hits = 0;
    let count = 0;
    for (let offset = 0; offset < stableRows; offset++) {
      const value = rowDark[index + offset];
      if (value === undefined) break;
      if (value < contentThreshold) hits++;
      count++;
    }
    return count > 0 && hits / count >= 0.7;
  };

  let top = -1;
  for (let y = 0; y < image.height; y++) {
    if (isContentRow(y)) {
      top = y;
      break;
    }
  }

  let bottom = -1;
  for (let y = image.height - 1; y >= 0; y--) {
    let hits = 0;
    let count = 0;
    for (let offset = 0; offset < stableRows; offset++) {
      const value = rowDark[y - offset];
      if (value === undefined) break;
      if (value < contentThreshold) hits++;
      count++;
    }
    if (count > 0 && hits / count >= 0.7) {
      bottom = y;
      break;
    }
  }

  if (top < 0 || bottom < top || bottom - top + 1 < minContentHeight) return null;

  const hasTopMatte = top >= minBand && averageDarkRatioInRows(image, 0, top - 1) >= matteThreshold;
  const hasBottomMatte =
    image.height - 1 - bottom >= minBand && averageDarkRatioInRows(image, bottom + 1, image.height - 1) >= matteThreshold;
  if (!hasTopMatte && !hasBottomMatte) return null;

  let left = 0;
  let right = image.width - 1;
  const minSideBand = Math.floor(image.width * 0.06);
  const colContentThreshold = 0.58;

  if (darkRatioInCol(image, 0, top, bottom) >= matteThreshold) {
    for (let x = 0; x < image.width; x++) {
      if (darkRatioInCol(image, x, top, bottom) < colContentThreshold) {
        left = x;
        break;
      }
    }
  }

  if (darkRatioInCol(image, image.width - 1, top, bottom) >= matteThreshold) {
    for (let x = image.width - 1; x >= left; x--) {
      if (darkRatioInCol(image, x, top, bottom) < colContentThreshold) {
        right = x;
        break;
      }
    }
  }

  const hasSideMatte = left >= minSideBand || image.width - 1 - right >= minSideBand;
  const box = refineBlackEdges(image, {
    left: hasSideMatte ? left : 0,
    top,
    width: hasSideMatte ? right - left + 1 : image.width,
    height: bottom - top + 1
  });

  return scoreBox(image, box, "black-matte", hasTopMatte && hasBottomMatte ? 1.25 : 0.9);
}

function refineBlackEdges(image: AnalysisImage, box: CropBox): CropBox {
  let left = clamp(box.left, 0, image.width - 2);
  let top = clamp(box.top, 0, image.height - 2);
  let right = clamp(box.left + box.width - 1, left + 1, image.width - 1);
  let bottom = clamp(box.top + box.height - 1, top + 1, image.height - 1);
  const maxTrimX = Math.max(1, Math.floor((right - left + 1) * 0.025));
  const maxTrimY = Math.max(1, Math.floor((bottom - top + 1) * 0.025));
  const edgeThreshold = 0.68;

  for (let i = 0; i < maxTrimY && bottom - top > 2 && darkRatioInRow(image, top, left, right) >= edgeThreshold; i++) {
    top++;
  }

  for (let i = 0; i < maxTrimY && bottom - top > 2 && darkRatioInRow(image, bottom, left, right) >= edgeThreshold; i++) {
    bottom--;
  }

  for (let i = 0; i < maxTrimX && right - left > 2 && darkRatioInCol(image, left, top, bottom) >= edgeThreshold; i++) {
    left++;
  }

  for (let i = 0; i < maxTrimX && right - left > 2 && darkRatioInCol(image, right, top, bottom) >= edgeThreshold; i++) {
    right--;
  }

  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

function colorSpreadInRow(image: AnalysisImage, y: number, left = 0, right = image.width - 1) {
  const safeLeft = clamp(left, 0, image.width - 1);
  const safeRight = clamp(right, safeLeft, image.width - 1);
  const step = Math.max(1, Math.floor((safeRight - safeLeft + 1) / 160));
  const samples: Rgb[] = [];

  for (let x = safeLeft; x <= safeRight; x += step) {
    samples.push(pixelAt(image, x, y));
  }

  const base = rowAverageColor(image, y, safeLeft, safeRight);
  return samples.reduce((sum, color) => sum + rgbDistance(color, base), 0) / Math.max(1, samples.length);
}

function colorSpreadInCol(image: AnalysisImage, x: number, top = 0, bottom = image.height - 1) {
  const safeTop = clamp(top, 0, image.height - 1);
  const safeBottom = clamp(bottom, safeTop, image.height - 1);
  const step = Math.max(1, Math.floor((safeBottom - safeTop + 1) / 160));
  const samples: Rgb[] = [];

  for (let y = safeTop; y <= safeBottom; y += step) {
    samples.push(pixelAt(image, x, y));
  }

  const base = colAverageColor(image, x, safeTop, safeBottom);
  return samples.reduce((sum, color) => sum + rgbDistance(color, base), 0) / Math.max(1, samples.length);
}

function trimSolidEdges(image: AnalysisImage, box: CropBox): { box: CropBox; trimmed: boolean } {
  let left = clamp(box.left, 0, image.width - 2);
  let top = clamp(box.top, 0, image.height - 2);
  let right = clamp(box.left + box.width - 1, left + 1, image.width - 1);
  let bottom = clamp(box.top + box.height - 1, top + 1, image.height - 1);
  const maxTrimX = Math.max(2, Math.floor((right - left + 1) * 0.22));
  const maxTrimY = Math.max(2, Math.floor((bottom - top + 1) * 0.18));
  const minWidth = Math.max(16, Math.floor(box.width * 0.45));
  const minHeight = Math.max(16, Math.floor(box.height * 0.45));
  const solidSpread = 9;
  const darkThreshold = 0.78;
  let trimmed = false;

  const isSolidRow = (y: number) =>
    darkRatioInRow(image, y, left, right, 38) >= darkThreshold || colorSpreadInRow(image, y, left, right) <= solidSpread;
  const isSolidCol = (x: number) =>
    darkRatioInCol(image, x, top, bottom, 38) >= darkThreshold || colorSpreadInCol(image, x, top, bottom) <= solidSpread;

  for (let i = 0; i < maxTrimY && bottom - top + 1 > minHeight && isSolidRow(top); i++) {
    top++;
    trimmed = true;
  }

  for (let i = 0; i < maxTrimY && bottom - top + 1 > minHeight && isSolidRow(bottom); i++) {
    bottom--;
    trimmed = true;
  }

  for (let i = 0; i < maxTrimX && right - left + 1 > minWidth && isSolidCol(left); i++) {
    left++;
    trimmed = true;
  }

  for (let i = 0; i < maxTrimX && right - left + 1 > minWidth && isSolidCol(right); i++) {
    right--;
    trimmed = true;
  }

  if (trimmed) {
    const insetX = right - left > 80 ? 1 : 0;
    const insetY = bottom - top > 80 ? 1 : 0;
    left = clamp(left + insetX, 0, image.width - 2);
    top = clamp(top + insetY, 0, image.height - 2);
    right = clamp(right - insetX, left + 1, image.width - 1);
    bottom = clamp(bottom - insetY, top + 1, image.height - 1);
  }

  return { box: { left, top, width: right - left + 1, height: bottom - top + 1 }, trimmed };
}

function trimOuterPageEdges(image: AnalysisImage, box: CropBox, palette: Rgb[]): CropBox {
  let left = clamp(box.left, 0, image.width - 2);
  let top = clamp(box.top, 0, image.height - 2);
  let right = clamp(box.left + box.width - 1, left + 1, image.width - 1);
  let bottom = clamp(box.top + box.height - 1, top + 1, image.height - 1);
  const tolerance = clamp(Math.min(image.width, image.height) / 18, 20, 42);
  const maxTrimX = Math.max(2, Math.floor((right - left + 1) * 0.028));
  const maxTrimY = Math.max(2, Math.floor((bottom - top + 1) * 0.022));

  const looksLikePageChrome = (color: Rgb, spread: number, dark: number) => {
    const luma = luminance(color);
    return spread < 12 && (isNearPalette(color, palette, tolerance) || luma > 238 || luma < 48 || dark > 0.88);
  };

  const isOuterRow = (y: number, direction: 1 | -1) => {
    const color = rowAverageColor(image, y, left, right);
    const spread = colorSpreadInRow(image, y, left, right);
    const dark = darkRatioInRow(image, y, left, right, 42);
    const probeY = clamp(y + direction * Math.max(3, Math.floor((bottom - top + 1) * 0.03)), top, bottom);
    const probeSpread = colorSpreadInRow(image, probeY, left, right);
    const probeDistance = rgbDistance(color, rowAverageColor(image, probeY, left, right));
    return looksLikePageChrome(color, spread, dark) && (probeDistance > 10 || probeSpread > 16);
  };

  const isOuterCol = (x: number, direction: 1 | -1) => {
    const color = colAverageColor(image, x, top, bottom);
    const spread = colorSpreadInCol(image, x, top, bottom);
    const dark = darkRatioInCol(image, x, top, bottom, 42);
    const probeX = clamp(x + direction * Math.max(3, Math.floor((right - left + 1) * 0.03)), left, right);
    const probeSpread = colorSpreadInCol(image, probeX, top, bottom);
    const probeDistance = rgbDistance(color, colAverageColor(image, probeX, top, bottom));
    return looksLikePageChrome(color, spread, dark) && (probeDistance > 10 || probeSpread > 16);
  };

  for (let i = 0; i < maxTrimY && bottom - top > 2 && isOuterRow(top, 1); i++) top++;
  for (let i = 0; i < maxTrimY && bottom - top > 2 && isOuterRow(bottom, -1); i++) bottom--;
  for (let i = 0; i < maxTrimX && right - left > 2 && isOuterCol(left, 1); i++) left++;
  for (let i = 0; i < maxTrimX && right - left > 2 && isOuterCol(right, -1); i++) right--;

  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

function rowContentActivity(image: AnalysisImage, y: number, left: number, right: number, palette: Rgb[]) {
  const safeLeft = clamp(left, 0, image.width - 1);
  const safeRight = clamp(right, safeLeft, image.width - 1);
  const tolerance = clamp(Math.min(image.width, image.height) / 18, 20, 42);
  const step = Math.max(1, Math.floor((safeRight - safeLeft + 1) / 180));
  let active = 0;
  let count = 0;

  for (let x = safeLeft; x <= safeRight; x += step) {
    const color = pixelAt(image, x, y);
    const spread = Math.max(...color) - Math.min(...color);
    if (!isNearPalette(color, palette, tolerance) || luminance(color) < 232 || spread > 18) {
      active++;
    }
    count++;
  }

  return count > 0 ? active / count : 0;
}

function trimDetailTextTail(image: AnalysisImage, box: CropBox, palette: Rgb[]): { box: CropBox; trimmed: boolean } {
  const left = clamp(box.left, 0, image.width - 2);
  const top = clamp(box.top, 0, image.height - 2);
  const right = clamp(box.left + box.width - 1, left + 1, image.width - 1);
  const bottom = clamp(box.top + box.height - 1, top + 1, image.height - 1);
  const minBottom = top + Math.floor(box.height * 0.58);
  const stable = Math.max(2, Math.floor(box.height * 0.006));
  const lowActivity = 0.24;
  const imageActivity = 0.36;

  let lowRun = 0;
  for (let y = bottom; y > minBottom; y--) {
    const activity = rowContentActivity(image, y, left, right, palette);
    if (activity <= lowActivity) {
      lowRun++;
      continue;
    }

    if (activity >= imageActivity && lowRun >= stable) {
      const newBottom = clamp(y + Math.max(1, Math.floor(stable / 2)), top + 1, bottom);
      if (bottom - newBottom > image.height * 0.025) {
        return { box: { left, top, width: right - left + 1, height: newBottom - top + 1 }, trimmed: true };
      }
      break;
    }

    lowRun = 0;
  }

  return { box: { left, top, width: right - left + 1, height: bottom - top + 1 }, trimmed: false };
}

function strongestGradientBetween(values: number[], start: number, end: number) {
  const safeStart = clamp(start, 0, values.length - 1);
  const safeEnd = clamp(end, safeStart, values.length - 1);
  let best = safeStart;
  let bestValue = -1;

  for (let i = safeStart; i <= safeEnd; i++) {
    if ((values[i] ?? 0) > bestValue) {
      best = i;
      bestValue = values[i] ?? 0;
    }
  }

  return { index: best, value: bestValue };
}

function refineFullWidthDetailEdges(image: AnalysisImage, box: CropBox, rowGradient: number[]): { box: CropBox; trimmed: boolean } {
  if (box.width < image.width * 0.9) return { box, trimmed: false };

  const left = clamp(box.left, 0, image.width - 2);
  let top = clamp(box.top, 0, image.height - 2);
  const right = clamp(box.left + box.width - 1, left + 1, image.width - 1);
  let bottom = clamp(box.top + box.height - 1, top + 1, image.height - 1);
  const topSearch = strongestGradientBetween(
    rowGradient,
    Math.max(top, Math.floor(image.height * 0.1)),
    Math.min(bottom - 2, top + Math.floor(image.height * 0.12))
  );
  const bottomSearch = strongestGradientBetween(
    rowGradient,
    Math.max(top + Math.floor((bottom - top + 1) * 0.58), top + 2),
    bottom
  );
  let trimmed = false;

  if (topSearch.value > 0.04 && topSearch.index - top > image.height * 0.015) {
    top = topSearch.index;
    trimmed = true;
  }

  if (bottomSearch.value > 0.04 && bottom - bottomSearch.index > image.height * 0.015) {
    bottom = bottomSearch.index;
    trimmed = true;
  }

  return { box: { left, top, width: right - left + 1, height: bottom - top + 1 }, trimmed };
}

function averageRowSpread(image: AnalysisImage, start: number, end: number, left = 0, right = image.width - 1) {
  const safeStart = clamp(start, 0, image.height - 1);
  const safeEnd = clamp(end, safeStart, image.height - 1);
  const step = Math.max(1, Math.floor((safeEnd - safeStart + 1) / 10));
  let sum = 0;
  let count = 0;

  for (let y = safeStart; y <= safeEnd; y += step) {
    sum += colorSpreadInRow(image, y, left, right);
    count++;
  }

  return count > 0 ? sum / count : 0;
}

function findDetailMediaTop(image: AnalysisImage, rowGradient: number[], palette: Rgb[]) {
  const searchStart = Math.floor(image.height * 0.125);
  const searchEnd = Math.floor(image.height * 0.22);
  let best = -1;
  let bestScore = -1;

  for (let y = searchStart; y <= searchEnd; y++) {
    const rawGradient =
      y < image.height - 1 ? averageEdgeDistance(rowAverageColor(image, y), rowAverageColor(image, y + 1)) : 0;
    const gradient = Math.max(rowGradient[y] ?? 0, rawGradient);
    const below = rowAverageColor(image, clamp(y + Math.floor(image.height * 0.012), 0, image.height - 1));
    const bgDistance = nearestPaletteDistance(below, palette);
    const score = gradient * 1.9 + Math.min(0.22, bgDistance / 255);
    if (score > bestScore && (gradient > 0.045 || bgDistance > 18)) {
      best = y;
      bestScore = score;
    }
  }

  if (best >= 0) return Math.max(best, searchStart);

  const tolerance = clamp(Math.min(image.width, image.height) / 18, 20, 42);
  let runStart = -1;
  for (let y = searchStart; y <= searchEnd; y++) {
    const color = rowAverageColor(image, y);
    const active = !isNearPalette(color, palette, tolerance) || colorSpreadInRow(image, y) > 18;
    if (active) {
      if (runStart < 0) runStart = y;
      if (y - runStart > image.height * 0.018) return Math.max(runStart, searchStart);
    } else {
      runStart = -1;
    }
  }

  return -1;
}

function findDetailMediaBottom(image: AnalysisImage, top: number, rowGradient: number[], left = 0, right = image.width - 1) {
  const searchStart = clamp(top + Math.floor(image.height * 0.45), 0, image.height - 1);
  const searchEnd = Math.floor(image.height * 0.8);
  let best = -1;
  let bestScore = -1;

  for (let y = searchStart; y <= searchEnd; y++) {
    const rawGradient =
      y < image.height - 1
        ? averageEdgeDistance(rowAverageColor(image, y, left, right), rowAverageColor(image, y + 1, left, right))
        : 0;
    const gradient = Math.max(rowGradient[y] ?? 0, rawGradient);
    const belowSpread = averageRowSpread(image, y + 1, Math.min(searchEnd, y + Math.floor(image.height * 0.014)), left, right);
    if (gradient > 0.035 && belowSpread < 32) return y;

    const belowLooksLikePage = belowSpread < 32 ? 0.18 : 0;
    const score = gradient * 1.8 + belowLooksLikePage;
    if (gradient > 0.055 && score > bestScore) {
      best = y;
      bestScore = score;
    }
  }

  if (best >= 0) return best;

  const fallback = strongestGradientBetween(rowGradient, searchStart, searchEnd);
  return fallback.value > 0.035 ? fallback.index : -1;
}

function redRatioInRow(image: AnalysisImage, y: number, left: number, right: number) {
  const safeLeft = clamp(left, 0, image.width - 1);
  const safeRight = clamp(right, safeLeft, image.width - 1);
  const step = Math.max(1, Math.floor((safeRight - safeLeft + 1) / 180));
  let red = 0;
  let count = 0;

  for (let x = safeLeft; x <= safeRight; x += step) {
    const [r, g, b] = pixelAt(image, x, y);
    if (r > 165 && g < 95 && b < 135 && r - g > 55 && r - b > 35) red++;
    count++;
  }

  return count > 0 ? red / count : 0;
}

function findXhsCarouselDotY(image: AnalysisImage, top: number, left: number, right: number) {
  const mediaCenter = (left + right) / 2;
  const dotBandHalf = Math.max(24, Math.floor(image.width * 0.18));
  const bandLeft = clamp(Math.floor(mediaCenter - dotBandHalf), 0, image.width - 1);
  const bandRight = clamp(Math.ceil(mediaCenter + dotBandHalf), bandLeft, image.width - 1);
  const searchStart = clamp(top + Math.floor(image.height * 0.52), 0, image.height - 1);
  const searchEnd = Math.floor(image.height * 0.84);
  const minRedRatio = 0.012;
  let bestY = -1;
  let bestScore = 0;

  for (let y = searchStart; y <= searchEnd; y++) {
    const redRatio = redRatioInRow(image, y, bandLeft, bandRight);
    if (redRatio < minRedRatio) continue;

    const rowDark = darkRatioInRow(image, y, bandLeft, bandRight, 50);
    const rowSpread = colorSpreadInRow(image, y, bandLeft, bandRight);
    if (rowSpread > 36) continue;
    const below = rowAverageColor(image, clamp(y + Math.floor(image.height * 0.018), 0, image.height - 1), bandLeft, bandRight);
    const score = redRatio * 4 + rowSpread / 255 + (luminance(below) > 70 ? 0.08 : 0) - rowDark * 0.08;
    if (score > bestScore) {
      bestY = y;
      bestScore = score;
    }
  }

  return bestScore > 0.11 ? bestY : -1;
}

function extendDarkEmbeddedMediaBottom(image: AnalysisImage, top: number, bottom: number, left: number, right: number) {
  if (right - left + 1 > image.width * 0.86) return bottom;
  if (bottom <= top) return bottom;

  const currentDark = darkRatioInRow(image, bottom, left, right, 58);
  const currentLuma = luminance(rowAverageColor(image, bottom, left, right));
  if (currentDark < 0.45 && currentLuma > 105) return bottom;

  const searchEnd = Math.floor(image.height * 0.82);
  let lastMediaRow = bottom;

  for (let y = bottom + 1; y <= searchEnd; y++) {
    const avg = rowAverageColor(image, y, left, right);
    const luma = luminance(avg);
    const white = luma > 215 && colorSpreadInRow(image, y, left, right) < 24;
    const dark = darkRatioInRow(image, y, left, right, 58);

    if (white && y - lastMediaRow > image.height * 0.008) return lastMediaRow;
    if (dark > 0.38 || luma < 130 || colorSpreadInRow(image, y, left, right) > 24) lastMediaRow = y;
  }

  return lastMediaRow;
}

function rowPageFillStats(image: AnalysisImage, y: number, left: number, right: number) {
  const safeLeft = clamp(left, 0, image.width - 1);
  const safeRight = clamp(right, safeLeft, image.width - 1);
  const step = Math.max(1, Math.floor((safeRight - safeLeft + 1) / 180));
  let white = 0;
  let dark = 0;
  let count = 0;
  let luma = 0;

  for (let x = safeLeft; x <= safeRight; x += step) {
    const color = pixelAt(image, x, y);
    const value = luminance(color);
    if (value > 225) white++;
    if (value < 55) dark++;
    luma += value;
    count++;
  }

  return {
    whiteRatio: count > 0 ? white / count : 0,
    darkRatio: count > 0 ? dark / count : 0,
    luma: count > 0 ? luma / count : 0,
    spread: colorSpreadInRow(image, y, safeLeft, safeRight)
  };
}

function findWideDetailTextBoundary(image: AnalysisImage, top: number, bottom: number, left: number, right: number) {
  if (right - left + 1 < image.width * 0.9) return -1;

  const searchStart = clamp(top + Math.floor(image.height * 0.22), top + 1, image.height - 1);
  const searchEnd = clamp(Math.min(bottom, Math.floor(image.height * 0.72)), searchStart, image.height - 1);
  const run = Math.max(4, Math.floor(image.height * 0.01));

  const pageLike = (stats: ReturnType<typeof rowPageFillStats>) =>
    (stats.whiteRatio > 0.62 && stats.luma > 178) || (stats.darkRatio > 0.62 && stats.luma < 84);
  const mediaLike = (stats: ReturnType<typeof rowPageFillStats>) =>
    stats.whiteRatio < 0.35 && stats.darkRatio < 0.5 && stats.spread > 20;

  for (let y = searchStart; y <= searchEnd - run; y++) {
    let pageRows = 0;
    let pageLuma = 0;
    for (let offset = 0; offset < run; offset++) {
      const stats = rowPageFillStats(image, y + offset, left, right);
      if (pageLike(stats)) pageRows++;
      pageLuma += stats.luma;
    }

    if (pageRows < run * 0.72) continue;
    const avgPageLuma = pageLuma / run;

    let mediaRows = 0;
    let mediaLuma = 0;
    const beforeStart = Math.max(top, y - run * 2);
    for (let py = beforeStart; py < y; py++) {
      const stats = rowPageFillStats(image, py, left, right);
      if (mediaLike(stats)) mediaRows++;
      mediaLuma += stats.luma;
    }

    const beforeCount = Math.max(1, y - beforeStart);
    const lumaJump = Math.abs(avgPageLuma - mediaLuma / beforeCount);
    const enoughJump = avgPageLuma < 90 ? lumaJump > 26 : lumaJump > 55;
    if (mediaRows >= beforeCount * 0.45 && enoughJump) {
      return clamp(y - 1, top + 1, bottom);
    }
  }

  return -1;
}

function detectMediaColumns(image: AnalysisImage, top: number, bottom: number, palette: Rgb[]) {
  const tolerance = clamp(Math.min(image.width, image.height) / 18, 20, 42);
  const values = new Array<number>(image.width).fill(0);
  const sampleBottom = clamp(top + Math.floor((bottom - top + 1) * 0.62), top, bottom);
  const yStep = Math.max(1, Math.floor((sampleBottom - top + 1) / 150));

  for (let x = 0; x < image.width; x++) {
    let active = 0;
    let count = 0;
    for (let y = top; y <= sampleBottom; y += yStep) {
      const color = pixelAt(image, x, y);
      const spread = Math.max(...color) - Math.min(...color);
      if (!isNearPalette(color, palette, tolerance) || spread > 18) {
        active++;
      }
      count++;
    }
    values[x] = active / Math.max(1, count);
  }

  const smoothed = smooth(values, Math.max(2, Math.floor(image.width * 0.006)));
  const segments = findSegments(smoothed, 0.16, Math.floor(image.width * 0.28), 0, image.width - 1).sort((a, b) => {
    const widthA = a.end - a.start + 1;
    const widthB = b.end - b.start + 1;
    return b.score * widthB - a.score * widthA;
  });

  const best = segments[0];
  if (!best) return { left: 0, right: image.width - 1 };

  const width = best.end - best.start + 1;
  if (
    width < image.width * 0.45 ||
    width > image.width * 0.86 ||
    best.start < image.width * 0.04 ||
    image.width - 1 - best.end < image.width * 0.04
  ) {
    return { left: 0, right: image.width - 1 };
  }

  return {
    left: clamp(best.start, 0, image.width - 2),
    right: clamp(best.end, best.start + 1, image.width - 1)
  };
}

function detectXhsDetailMediaBox(
  image: AnalysisImage,
  palette: Rgb[],
  rowGradient: number[]
): DetectionResult | null {
  const top = findDetailMediaTop(image, rowGradient, palette);
  if (top < 0) return null;

  const roughBottom = findDetailMediaBottom(image, top, rowGradient);
  if (roughBottom <= top || roughBottom - top + 1 < image.height * 0.18) return null;

  const columns = detectMediaColumns(image, top, roughBottom, palette);
  let bottom = findDetailMediaBottom(image, top, rowGradient, columns.left, columns.right);
  if (bottom <= top || bottom - top + 1 < image.height * 0.18) return null;

  const carouselDotY = findXhsCarouselDotY(image, top, columns.left, columns.right);
  const hasCarouselAnchor = carouselDotY > 0;
  if (carouselDotY > bottom + image.height * 0.025) {
    bottom = clamp(carouselDotY - Math.floor(image.height * 0.018), top + 1, image.height - 1);
  }
  if (!hasCarouselAnchor) {
    bottom = extendDarkEmbeddedMediaBottom(image, top, bottom, columns.left, columns.right);
  }
  const textBoundary = findWideDetailTextBoundary(image, top, bottom, columns.left, columns.right);
  if (textBoundary > top && bottom - textBoundary > image.height * 0.025) {
    bottom = textBoundary;
  }

  let refinedTop = top;
  if (columns.left === 0 && columns.right === image.width - 1) {
    for (
      let i = 0;
      i < Math.max(1, Math.floor(image.height * 0.006)) &&
      refinedTop < bottom - 2 &&
      darkRatioInRow(image, refinedTop, columns.left, columns.right, 45) > 0.65;
      i++
    ) {
      refinedTop++;
    }
  }

  const box = {
    left: columns.left,
    top: refinedTop,
    width: columns.right - columns.left + 1,
    height: bottom - refinedTop + 1
  };
  const refinedBox = trimOuterPageEdges(image, box, palette);

  const areaRatio = (refinedBox.width * refinedBox.height) / (image.width * image.height);
  const centerPenalty = Math.abs(refinedBox.left + refinedBox.width / 2 - image.width / 2) / image.width;
  const metrics = candidateMetrics(image, refinedBox, palette);
  const topEdge = rowGradient[refinedBox.top] ?? 0;
  const bottomEdge = rowGradient[refinedBox.top + refinedBox.height - 1] ?? 0;
  const score =
    areaRatio * 0.22 +
    metrics.edgeScore * 0.35 +
    Math.min(0.28, (topEdge + bottomEdge) * 1.8) +
    metrics.contentDensity * 0.22 -
    centerPenalty * 0.28;

  const minScore = hasCarouselAnchor ? 0.28 : 0.36;
  if (refinedBox.width < image.width * 0.28 || score < minScore || centerPenalty > 0.28) return null;

  return candidateToResult(
    {
      detector: "xhs-detail-media",
      box: refinedBox,
      score,
      confidence: clamp(0.68 + score * 0.32 + (hasCarouselAnchor ? 0.03 : 0), 0.55, 0.96),
      metrics
    },
    image,
    palette,
    refinedBox
  );
}

function mapBoxToOriginal(box: CropBox, image: AnalysisImage): CropBox {
  const left = clamp(Math.floor(box.left * image.scaleX), 0, image.originalWidth - 2);
  const top = clamp(Math.floor(box.top * image.scaleY), 0, image.originalHeight - 2);
  const right = clamp(Math.ceil((box.left + box.width) * image.scaleX), left + 1, image.originalWidth);
  const bottom = clamp(Math.ceil((box.top + box.height) * image.scaleY), top + 1, image.originalHeight);
  return { left, top, width: right - left, height: bottom - top };
}

function mapBoxToOriginalTight(box: CropBox, image: AnalysisImage): CropBox {
  const left = clamp(Math.ceil(box.left * image.scaleX), 0, image.originalWidth - 2);
  const top = clamp(Math.ceil(box.top * image.scaleY), 0, image.originalHeight - 2);
  const right = clamp(Math.floor((box.left + box.width) * image.scaleX), left + 1, image.originalWidth);
  const bottom = clamp(Math.floor((box.top + box.height) * image.scaleY), top + 1, image.originalHeight);
  return { left, top, width: right - left, height: bottom - top };
}

function fallbackBox(width: number, height: number): CropBox {
  const left = Math.round(width * 0.08);
  const top = Math.round(height * 0.14);
  const cropWidth = Math.round(width * 0.84);
  const cropHeight = Math.round(height * 0.62);
  return { left, top, width: cropWidth, height: cropHeight };
}

function scoreBox(image: AnalysisImage, box: CropBox, detector: string, base = 0): Candidate {
  const areaRatio = (box.width * box.height) / (image.width * image.height);
  const widthRatio = box.width / image.width;
  const topRatio = box.top / image.height;
  const bottomRatio = (box.top + box.height) / image.height;
  const centerPenalty = Math.abs(box.left + box.width / 2 - image.width / 2) / image.width;
  const titlePenalty = bottomRatio > 0.78 ? (bottomRatio - 0.78) * 0.9 : 0;
  const topPenalty = topRatio < 0.03 ? 0.08 : 0;
  const score = base + areaRatio * 0.45 + widthRatio * 0.12 - centerPenalty * 0.35 - titlePenalty - topPenalty;
  const confidence = clamp(0.48 + score * 0.36, 0.35, 0.97);

  return { detector, box, score, confidence };
}

function averageEdgeDistance(a: Rgb, b: Rgb) {
  return clamp(rgbDistance(a, b) / 255, 0, 1);
}

function candidateMetrics(image: AnalysisImage, box: CropBox, palette: Rgb[]): CandidateMetrics {
  const tolerance = clamp(Math.min(image.width, image.height) / 18, 20, 42);
  const left = clamp(box.left, 0, image.width - 1);
  const right = clamp(box.left + box.width - 1, left, image.width - 1);
  const top = clamp(box.top, 0, image.height - 1);
  const bottom = clamp(box.top + box.height - 1, top, image.height - 1);
  const xStep = Math.max(1, Math.floor((right - left + 1) / 46));
  const yStep = Math.max(1, Math.floor((bottom - top + 1) / 62));
  let background = 0;
  let content = 0;
  let count = 0;

  for (let y = top; y <= bottom; y += yStep) {
    for (let x = left; x <= right; x += xStep) {
      const color = pixelAt(image, x, y);
      const nearBackground = isNearPalette(color, palette, tolerance);
      const spread = Math.max(...color) - Math.min(...color);
      const lum = luminance(color);
      if (nearBackground) background++;
      if (!nearBackground || lum < 238 || spread > 16) content++;
      count++;
    }
  }

  const edgeSamples: number[] = [];
  if (top > 1) {
    edgeSamples.push(averageEdgeDistance(rowAverageColor(image, top, left, right), rowAverageColor(image, top - 1, left, right)));
  }
  if (bottom < image.height - 2) {
    edgeSamples.push(averageEdgeDistance(rowAverageColor(image, bottom, left, right), rowAverageColor(image, bottom + 1, left, right)));
  }
  if (left > 1) {
    edgeSamples.push(averageEdgeDistance(colAverageColor(image, left, top, bottom), colAverageColor(image, left - 1, top, bottom)));
  }
  if (right < image.width - 2) {
    edgeSamples.push(averageEdgeDistance(colAverageColor(image, right, top, bottom), colAverageColor(image, right + 1, top, bottom)));
  }

  return {
    backgroundRatio: count > 0 ? background / count : 0,
    contentDensity: count > 0 ? content / count : 0,
    edgeScore: edgeSamples.length > 0 ? edgeSamples.reduce((sum, value) => sum + value, 0) / edgeSamples.length : 0
  };
}

function rankCandidate(candidate: Candidate, image: AnalysisImage, palette: Rgb[]): Candidate {
  if (candidate.fallback) return candidate;

  const metrics = candidateMetrics(image, candidate.box, palette);
  const areaRatio = (candidate.box.width * candidate.box.height) / (image.width * image.height);
  const widthRatio = candidate.box.width / image.width;
  const centerPenalty = Math.abs(candidate.box.left + candidate.box.width / 2 - image.width / 2) / image.width;
  const backgroundPenalty = metrics.backgroundRatio * 0.25;
  const contentReward = metrics.contentDensity * 0.32;
  const edgeReward = metrics.edgeScore * 0.7;
  const columnsBonus = candidate.detector === "wide-frame-columns" ? 0.26 : 0;
  const wideFrameBonus = candidate.detector === "wide-frame" ? 0.12 : 0;
  const blackMatteBonus = candidate.detector === "black-matte" ? 0.18 : 0;
  const fullWidthPenalty = candidate.detector === "wide-frame" && widthRatio > 0.94 && metrics.backgroundRatio > 0.55 ? 0.16 : 0;
  const score =
    candidate.score +
    areaRatio * 0.1 +
    contentReward +
    edgeReward +
    columnsBonus +
    wideFrameBonus +
    blackMatteBonus -
    backgroundPenalty -
    centerPenalty * 0.2 -
    fullWidthPenalty;

  return {
    ...candidate,
    metrics,
    score,
    confidence: clamp(0.48 + score * 0.32, 0.35, 0.97)
  };
}

function darkBandAverage(rowDark: number[], start: number, end: number) {
  const safeStart = clamp(start, 0, rowDark.length - 1);
  const safeEnd = clamp(end, safeStart, rowDark.length - 1);
  let sum = 0;
  for (let i = safeStart; i <= safeEnd; i++) {
    sum += rowDark[i] ?? 0;
  }
  return sum / (safeEnd - safeStart + 1);
}

function detectBlackMatte(image: AnalysisImage, rowDark: number[]) {
  const segments = findSegments(
    rowDark.map((value) => (value < 0.45 ? 1 : 0)),
    0.5,
    Math.floor(image.height * 0.2)
  );

  const candidates: Candidate[] = [];
  for (const segment of segments) {
    const topBandHeight = segment.start;
    const bottomBandHeight = image.height - 1 - segment.end;
    const touchesBlackTop = topBandHeight > image.height * 0.08 && darkBandAverage(rowDark, 0, segment.start - 1) > 0.72;
    const touchesBlackBottom =
      bottomBandHeight > image.height * 0.08 && darkBandAverage(rowDark, segment.end + 1, image.height - 1) > 0.72;
    if (!touchesBlackTop && !touchesBlackBottom) continue;

    const box = {
      left: 0,
      top: clamp(segment.start, 0, image.height - 2),
      width: image.width,
      height: clamp(segment.end - segment.start + 1, 1, image.height)
    };

    candidates.push(scoreBox(image, box, "black-matte", touchesBlackTop && touchesBlackBottom ? 0.95 : 0.65));
  }

  return candidates;
}

function findBoundaryBefore(values: number[], index: number, floor: number, window: number) {
  let best = index;
  let bestValue = -1;
  for (let i = Math.max(floor, index - window); i <= index; i++) {
    if ((values[i] ?? 0) > bestValue) {
      best = i;
      bestValue = values[i] ?? 0;
    }
  }
  return best;
}

function findBoundaryAfter(values: number[], index: number, ceiling: number, window: number) {
  let best = index;
  let bestValue = -1;
  for (let i = index; i <= Math.min(ceiling, index + window); i++) {
    if ((values[i] ?? 0) > bestValue) {
      best = i;
      bestValue = values[i] ?? 0;
    }
  }
  return best;
}

function detectMainCanvas(image: AnalysisImage, rowDiff: number[], colDiff: number[], rowGradient: number[], colGradient: number[]) {
  const minHeight = Math.floor(image.height * 0.18);
  const minWidth = Math.floor(image.width * 0.62);
  const topLimit = Math.floor(image.height * 0.08);
  const bottomLimit = Math.floor(image.height * 0.84);
  const rowSignal = rowDiff.map((diff, index) => Math.max(diff, (rowGradient[index] ?? 0) * 4));
  const colSignal = colDiff.map((diff, index) => Math.max(diff, (colGradient[index] ?? 0) * 3));
  const rowSegments = findSegments(rowSignal, 0.16, minHeight, topLimit, bottomLimit);
  const colSegments = findSegments(colSignal, 0.09, minWidth, 0, image.width - 1);
  const candidates: Candidate[] = [];

  for (const row of rowSegments) {
    const rowHeight = row.end - row.start + 1;
    const rowScore = row.score / Math.max(1, rowHeight);
    if (rowScore < 0.16) continue;

    for (const col of colSegments.length ? colSegments : [{ start: 0, end: image.width - 1, score: image.width }]) {
      const width = col.end - col.start + 1;
      if (width < minWidth) continue;

      const top = findBoundaryBefore(rowGradient, row.start, topLimit, Math.floor(image.height * 0.04));
      const bottom = findBoundaryAfter(rowGradient, row.end, row.start + minHeight, Math.floor(image.height * 0.05));
      const left = width > image.width * 0.92 ? 0 : findBoundaryBefore(colGradient, col.start, 0, Math.floor(image.width * 0.035));
      const right = width > image.width * 0.92 ? image.width - 1 : findBoundaryAfter(colGradient, col.end, col.start + minWidth, Math.floor(image.width * 0.035));

      const box = {
        left: clamp(left, 0, image.width - 2),
        top: clamp(top, 0, image.height - 2),
        width: clamp(right - left + 1, 1, image.width),
        height: clamp(bottom - top + 1, 1, image.height)
      };

      if (box.width < minWidth || box.height < minHeight) continue;
      const boundaryBonus = ((rowGradient[top] ?? 0) + (rowGradient[bottom] ?? 0)) * 1.6;
      const positionBonus = box.top > image.height * 0.1 && box.top < image.height * 0.35 ? 0.22 : 0;
      candidates.push(scoreBox(image, box, "main-canvas", boundaryBonus + positionBonus));
    }
  }

  return candidates;
}

function detectContentColumns(image: AnalysisImage, box: CropBox, palette: Rgb[]) {
  const tolerance = clamp(Math.min(image.width, image.height) / 18, 20, 42);
  const values = new Array<number>(image.width).fill(0);
  const top = clamp(box.top + Math.round(box.height * 0.04), 0, image.height - 1);
  const bottom = clamp(box.top + box.height - 1 - Math.round(box.height * 0.04), top, image.height - 1);
  const rowStep = Math.max(1, Math.floor((bottom - top + 1) / 130));
  const edgeMargin = Math.floor(image.width * 0.04);

  for (let x = edgeMargin; x < image.width - edgeMargin; x++) {
    let active = 0;
    let count = 0;
    for (let y = top; y <= bottom; y += rowStep) {
      const color = pixelAt(image, x, y);
      if (!isNearPalette(color, palette, tolerance) || luminance(color) < 235) {
        active++;
      }
      count++;
    }
    values[x] = active / count;
  }

  const smoothed = smooth(values, Math.max(2, Math.floor(image.width * 0.006)));
  const segments = findSegments(smoothed, 0.42, Math.floor(image.width * 0.28), edgeMargin, image.width - edgeMargin - 1);
  return segments
    .filter((segment) => {
      const width = segment.end - segment.start + 1;
      const center = segment.start + width / 2;
      const leftMargin = segment.start;
      const rightMargin = image.width - 1 - segment.end;
      const hasClearSideMargins = leftMargin > image.width * 0.08 && rightMargin > image.width * 0.08;
      return (
        width >= image.width * 0.32 &&
        width <= image.width * 0.82 &&
        hasClearSideMargins &&
        Math.abs(center - image.width / 2) < image.width * 0.22
      );
    })
    .sort((a, b) => {
      const widthA = a.end - a.start + 1;
      const widthB = b.end - b.start + 1;
      return b.score * widthB - a.score * widthA;
    });
}

function detectContentRows(image: AnalysisImage, box: CropBox, palette: Rgb[]) {
  const tolerance = clamp(Math.min(image.width, image.height) / 18, 20, 42);
  const values = new Array<number>(image.height).fill(0);
  const left = clamp(box.left + Math.round(box.width * 0.03), 0, image.width - 1);
  const right = clamp(box.left + box.width - 1 - Math.round(box.width * 0.03), left, image.width - 1);
  const top = clamp(box.top, 0, image.height - 1);
  const bottom = clamp(box.top + box.height - 1, top, image.height - 1);
  const colStep = Math.max(1, Math.floor((right - left + 1) / 96));

  for (let y = top; y <= bottom; y++) {
    let active = 0;
    let count = 0;
    for (let x = left; x <= right; x += colStep) {
      const color = pixelAt(image, x, y);
      const spread = Math.max(...color) - Math.min(...color);
      if (!isNearPalette(color, palette, tolerance) || luminance(color) < 242 || spread > 10) {
        active++;
      }
      count++;
    }
    values[y] = active / count;
  }

  const smoothed = smooth(values, Math.max(2, Math.floor(image.height * 0.004)));
  const segments = findSegments(smoothed, 0.1, Math.floor(box.height * 0.42), top, bottom);
  return segments
    .filter((segment) => {
      const height = segment.end - segment.start + 1;
      const center = segment.start + height / 2;
      return height >= box.height * 0.45 && height <= box.height * 0.98 && Math.abs(center - (box.top + box.height / 2)) < box.height * 0.18;
    })
    .sort((a, b) => {
      const heightA = a.end - a.start + 1;
      const heightB = b.end - b.start + 1;
      return b.score * heightB - a.score * heightA;
    });
}

function detectWideFrame(image: AnalysisImage, rowGradient: number[], palette: Rgb[]) {
  const candidates: Candidate[] = [];
  const topStart = Math.floor(image.height * 0.08);
  const topEnd = Math.floor(image.height * 0.4);
  const bottomStart = Math.floor(image.height * 0.35);
  const bottomEnd = Math.floor(image.height * 0.82);
  const strongRows = rowGradient
    .map((value, index) => ({ value, index }))
    .filter((item) => item.index >= topStart && item.index <= bottomEnd && item.value > 0.028)
    .sort((a, b) => b.value - a.value);

  const topRows = strongRows.filter((item) => item.index <= topEnd).slice(0, 5);
  const bottomRows = strongRows.filter((item) => item.index >= bottomStart).slice(0, 8);

  for (const top of topRows) {
    for (const bottom of bottomRows.filter((item) => item.index > top.index).slice(0, 6)) {
      const height = bottom.index - top.index + 1;
      if (height < image.height * 0.22) continue;
      if (height > image.height * 0.72) continue;

      const fullBox = { left: 0, top: top.index, width: image.width, height };
      const boundaryBonus = (top.value + bottom.value) * 2.2;
      const colSegments = detectContentColumns(image, fullBox, palette);

      if (colSegments.length > 0) {
        for (const col of colSegments.slice(0, 2)) {
          const colPadding = Math.max(1, Math.round((col.end - col.start + 1) * 0.004));
          const left = clamp(col.start + colPadding, 0, image.width - 2);
          const right = clamp(col.end - colPadding, left + 1, image.width - 1);
          const columnBox = { left, top: top.index, width: right - left + 1, height };
          const rowSegments = detectContentRows(image, columnBox, palette);

          if (rowSegments.length > 0) {
            for (const row of rowSegments.slice(0, 2)) {
              const rowPadding = Math.max(1, Math.round((row.end - row.start + 1) * 0.003));
              const refinedTop = clamp(row.start + rowPadding, top.index, top.index + height - 2);
              const refinedBottom = clamp(row.end - rowPadding, refinedTop + 1, top.index + height - 1);
              candidates.push(
                scoreBox(
                  image,
                  { left, top: refinedTop, width: right - left + 1, height: refinedBottom - refinedTop + 1 },
                  "wide-frame-columns",
                  boundaryBonus + 0.34
                )
              );
            }
          }

          candidates.push(scoreBox(image, columnBox, "wide-frame-columns", boundaryBonus + 0.18));
        }
      }

      candidates.push(scoreBox(image, fullBox, "wide-frame", boundaryBonus - 0.08));
    }
  }

  return candidates;
}

function candidateToResult(
  candidate: Candidate,
  image: AnalysisImage,
  palette: Rgb[],
  refinedBox = candidate.box,
  fallback = false
): DetectionResult {
  const cropBox = mapBoxToOriginalTight(refinedBox, image);
  const metrics = candidate.metrics ?? candidateMetrics(image, refinedBox, palette);

  return {
    box: cropBox,
    confidence: candidate.confidence,
    detector: candidate.detector,
    fallback,
    background: palette,
    candidates: [
      {
        detector: candidate.detector,
        score: Number(candidate.score.toFixed(3)),
        confidence: Number(candidate.confidence.toFixed(2)),
        backgroundRatio: Number(metrics.backgroundRatio.toFixed(3)),
        edgeScore: Number(metrics.edgeScore.toFixed(3)),
        contentDensity: Number(metrics.contentDensity.toFixed(3)),
        cropBox
      }
    ]
  };
}

function detectXhsDetailPage(
  image: AnalysisImage,
  palette: Rgb[],
  rowDiff: number[],
  colDiff: number[],
  rowGradient: number[],
  colGradient: number[]
): DetectionResult | null {
  const topLimit = Math.floor(image.height * 0.06);
  const bottomLimit = Math.floor(image.height * 0.78);
  const minHeight = Math.floor(image.height * 0.2);
  const maxHeight = Math.floor(image.height * 0.68);
  const minWidth = Math.floor(image.width * 0.48);
  const edgeX = Math.floor(image.width * 0.04);
  const rowSignal = rowDiff.map((diff, index) => Math.max(diff, (rowGradient[index] ?? 0) * 3.8));
  const colSignal = colDiff.map((diff, index) => Math.max(diff, (colGradient[index] ?? 0) * 2.6));
  const rowSegments = findSegments(rowSignal, 0.13, minHeight, topLimit, bottomLimit);
  const colSegments = findSegments(colSignal, 0.075, minWidth, edgeX, image.width - edgeX - 1);
  const candidates: Candidate[] = [];

  for (const row of rowSegments) {
    const top = findBoundaryBefore(rowGradient, row.start, topLimit, Math.floor(image.height * 0.045));
    const bottom = findBoundaryAfter(rowGradient, row.end, row.start + minHeight, Math.floor(image.height * 0.045));
    const height = bottom - top + 1;
    if (height < minHeight || height > maxHeight) continue;

    const usableCols = colSegments.length
      ? colSegments
      : [{ start: edgeX, end: image.width - edgeX - 1, score: image.width - edgeX * 2 }];

    for (const col of usableCols) {
      const width = col.end - col.start + 1;
      if (width < minWidth) continue;

      const fillsMostWidth = width > image.width * 0.84;
      const left = fillsMostWidth ? 0 : findBoundaryBefore(colGradient, col.start, 0, Math.floor(image.width * 0.045));
      const right = fillsMostWidth
        ? image.width - 1
        : findBoundaryAfter(colGradient, col.end, col.start + minWidth, Math.floor(image.width * 0.045));
      const box = {
        left: clamp(left, 0, image.width - 2),
        top: clamp(top, 0, image.height - 2),
        width: clamp(right - left + 1, 1, image.width),
        height: clamp(height, 1, image.height)
      };

      const areaRatio = (box.width * box.height) / (image.width * image.height);
      const centerPenalty = Math.abs(box.left + box.width / 2 - image.width / 2) / image.width;
      const topRatio = box.top / image.height;
      const bottomRatio = (box.top + box.height) / image.height;
      const metrics = candidateMetrics(image, box, palette);
      const topEdge = rowGradient[box.top] ?? 0;
      const bottomEdge = rowGradient[box.top + box.height - 1] ?? 0;
      const structuralScore =
        metrics.contentDensity * 0.44 +
        metrics.edgeScore * 0.55 +
        Math.min(0.18, (topEdge + bottomEdge) * 1.7) +
        areaRatio * 0.18 -
        centerPenalty * 0.38 -
        (topRatio < 0.04 ? 0.22 : 0) -
        (bottomRatio > 0.86 ? 0.3 : 0);

      if (metrics.contentDensity < 0.34 || centerPenalty > 0.18 || structuralScore < 0.34) continue;

      candidates.push({
        detector: "xhs-detail-container",
        box,
        score: structuralScore,
        confidence: clamp(0.58 + structuralScore * 0.38, 0.45, 0.94),
        metrics
      });
    }
  }

  const best = candidates.sort((a, b) => b.score - a.score)[0];
  if (!best || best.confidence < 0.71) return null;

  const fullWidthEdges = refineFullWidthDetailEdges(image, best.box, rowGradient);
  const withoutTextTail =
    fullWidthEdges.box.width > image.width * 0.9 ? trimDetailTextTail(image, fullWidthEdges.box, palette) : fullWidthEdges;
  const trimmed = trimSolidEdges(image, withoutTextTail.box);
  const finalCandidate = {
    ...best,
    detector: trimmed.trimmed || withoutTextTail.trimmed || fullWidthEdges.trimmed ? "xhs-detail-inner-trim" : best.detector,
    box: trimmed.box,
    confidence: clamp(best.confidence + (trimmed.trimmed ? 0.02 : 0), 0.45, 0.96),
    metrics: candidateMetrics(image, trimmed.box, palette)
  };

  return candidateToResult(finalCandidate, image, palette, trimmed.box);
}

function detectXhsPreviewPage(image: AnalysisImage, palette: Rgb[]): DetectionResult | null {
  const sideBand = Math.max(8, Math.floor(image.width * 0.05));
  const topBand = Math.max(12, Math.floor(image.height * 0.1));
  const bottomBand = Math.max(12, Math.floor(image.height * 0.08));
  const topDark = averageDarkRatioInRows(image, 0, topBand);
  const bottomDark = averageDarkRatioInRows(image, image.height - 1 - bottomBand, image.height - 1);
  const sideDark =
    (averageDarkRatioInCols(image, 0, sideBand) +
      averageDarkRatioInCols(image, image.width - 1 - sideBand, image.width - 1)) /
    2;
  const previewDark = topDark * 0.5 + bottomDark * 0.35 + sideDark * 0.15;

  if (previewDark < 0.68 || topDark < 0.62 || bottomDark < 0.62 || sideDark < 0.42) return null;

  const contentThreshold = 0.58;
  const stableRows = Math.max(2, Math.floor(image.height * 0.006));
  const rowHasContent = (y: number) => {
    let hits = 0;
    let count = 0;
    for (let offset = 0; offset < stableRows; offset++) {
      const value = darkRatioInRow(image, y + offset, sideBand, image.width - 1 - sideBand, 38);
      if (value < contentThreshold) hits++;
      count++;
    }
    return hits / Math.max(1, count) >= 0.65;
  };

  let top = -1;
  for (let y = topBand; y < image.height - bottomBand; y++) {
    if (rowHasContent(y)) {
      top = y;
      break;
    }
  }

  let bottom = -1;
  for (let y = image.height - 1 - bottomBand; y > topBand; y--) {
    if (darkRatioInRow(image, y, sideBand, image.width - 1 - sideBand, 38) < contentThreshold) {
      bottom = y;
      break;
    }
  }

  if (top < 0 || bottom <= top || bottom - top + 1 < image.height * 0.18) return null;

  let left = 0;
  let right = image.width - 1;
  for (let x = 0; x < image.width; x++) {
    if (darkRatioInCol(image, x, top, bottom, 38) < 0.58) {
      left = x;
      break;
    }
  }

  for (let x = image.width - 1; x >= left; x--) {
    if (darkRatioInCol(image, x, top, bottom, 38) < 0.58) {
      right = x;
      break;
    }
  }

  const box = { left, top, width: right - left + 1, height: bottom - top + 1 };
  if (box.width < image.width * 0.28 || box.height < image.height * 0.18) return null;

  const refined = refineBlackEdges(image, box);
  const sideTrimmed = refined.left > image.width * 0.025 || refined.left + refined.width < image.width * 0.975;
  const topTrimmed = refined.top > image.height * 0.08;
  const metrics = candidateMetrics(image, refined, palette);
  const score = previewDark * 0.48 + metrics.contentDensity * 0.22 + (topTrimmed ? 0.2 : 0) + (sideTrimmed ? 0.1 : 0);

  if (score < 0.56) return null;

  return candidateToResult(
    {
      detector: "xhs-preview",
      box: refined,
      score,
      confidence: clamp(0.6 + score * 0.34, 0.45, 0.96),
      metrics
    },
    image,
    palette,
    refined
  );
}

function normalizeCandidate(candidate: Candidate, image: AnalysisImage): Candidate {
  const insetX = candidate.detector === "black-matte" || candidate.box.width > image.width * 0.94 ? 0 : Math.round(candidate.box.width * 0.004);
  const insetY = candidate.detector === "black-matte" ? 0 : Math.round(candidate.box.height * 0.004);
  const left = clamp(candidate.box.left + insetX, 0, image.width - 2);
  const top = clamp(candidate.box.top + insetY, 0, image.height - 2);
  const right = clamp(candidate.box.left + candidate.box.width - insetX, left + 1, image.width);
  const bottom = clamp(candidate.box.top + candidate.box.height - insetY, top + 1, image.height);

  return {
    ...candidate,
    box: { left, top, width: right - left, height: bottom - top }
  };
}

function detectGenericCropBox(image: AnalysisImage, palette: Rgb[], signals: ReturnType<typeof buildSignals>): DetectionResult {
  const fastBlackMatte = detectFastBlackMatte(image);
  if (fastBlackMatte) {
    const refined = refineBlackEdges(image, fastBlackMatte.box);
    const cropBox = mapBoxToOriginalTight(refined, image);
    return {
      box: cropBox,
      confidence: 0.96,
      detector: fastBlackMatte.detector,
      fallback: false,
      background: [],
      candidates: [
        {
          detector: fastBlackMatte.detector,
          score: Number(fastBlackMatte.score.toFixed(3)),
          confidence: 0.96,
          cropBox
        }
      ]
    };
  }

  const fallback = scoreBox(image, fallbackBox(image.width, image.height), "fallback", -0.15);
  fallback.score = -0.5;
  fallback.confidence = 0.35;
  fallback.fallback = true;

  const roughCandidates = [
    ...detectBlackMatte(image, signals.rowDark),
    ...detectMainCanvas(image, signals.rowDiff, signals.colDiff, signals.rowGradient, signals.colGradient),
    ...detectWideFrame(image, signals.rowGradient, palette),
    fallback
  ]
    .map((candidate) => normalizeCandidate(candidate, image))
    .filter((candidate) => candidate.box.width >= image.width * 0.45 && candidate.box.height >= image.height * 0.16);

  const candidates = roughCandidates
    .filter((candidate) => !candidate.fallback)
    .sort((a, b) => b.score - a.score)
    .slice(0, 24)
    .concat(fallback)
    .map((candidate) => rankCandidate(candidate, image, palette))
    .sort((a, b) => b.score - a.score);

  const best = candidates[0] ?? fallback;
  const refined = refineBlackEdges(image, best.box);
  return {
    box: mapBoxToOriginalTight(refined, image),
    confidence: best.confidence,
    detector: best.detector,
    fallback: best.fallback ?? false,
    background: palette,
    candidates: candidates.slice(0, 6).map((candidate) => ({
      detector: candidate.detector,
      score: Number(candidate.score.toFixed(3)),
      confidence: Number(candidate.confidence.toFixed(2)),
      backgroundRatio: candidate.metrics ? Number(candidate.metrics.backgroundRatio.toFixed(3)) : undefined,
      edgeScore: candidate.metrics ? Number(candidate.metrics.edgeScore.toFixed(3)) : undefined,
      contentDensity: candidate.metrics ? Number(candidate.metrics.contentDensity.toFixed(3)) : undefined,
      cropBox: mapBoxToOriginalTight(refineBlackEdges(image, candidate.box), image)
    }))
  };
}

function detectFastBlackMatteCropBox(image: AnalysisImage): DetectionResult | null {
  const fastBlackMatte = detectFastBlackMatte(image);
  if (!fastBlackMatte) return null;
  if (fastBlackMatte.box.top < image.height * 0.17) return null;

  const refined = refineBlackEdges(image, fastBlackMatte.box);
  const cropBox = mapBoxToOriginalTight(refined, image);
  return {
    box: cropBox,
    confidence: 0.96,
    detector: fastBlackMatte.detector,
    fallback: false,
    background: [],
    candidates: [
      {
        detector: fastBlackMatte.detector,
        score: Number(fastBlackMatte.score.toFixed(3)),
        confidence: 0.96,
        cropBox
      }
    ]
  };
}

function detectCropBox(image: AnalysisImage): DetectionResult {
  const palette = estimateBackgroundPalette(image);
  const signals = buildSignals(image, palette);

  const fastBlackMatte = detectFastBlackMatteCropBox(image);
  if (fastBlackMatte) return fastBlackMatte;

  const detailMedia = detectXhsDetailMediaBox(image, palette, signals.rowGradient);
  if (detailMedia) return detailMedia;

  const detail = detectXhsDetailPage(
    image,
    palette,
    signals.rowDiff,
    signals.colDiff,
    signals.rowGradient,
    signals.colGradient
  );
  if (detail) return detail;

  const preview = detectXhsPreviewPage(image, palette);
  if (preview) return preview;

  return detectGenericCropBox(image, palette, signals);
}

async function createAnalysisImage(image: sharp.Sharp): Promise<AnalysisImage> {
  const metadata = await image.metadata();
  const originalWidth = metadata.width ?? 0;
  const originalHeight = metadata.height ?? 0;

  if (!originalWidth || !originalHeight || originalWidth < 100 || originalHeight < 100) {
    throw new Error("图片尺寸过小，无法识别");
  }

  const maxSide = 720;
  const ratio = Math.min(1, maxSide / Math.max(originalWidth, originalHeight));
  const width = Math.max(1, Math.round(originalWidth * ratio));
  const height = Math.max(1, Math.round(originalHeight * ratio));
  const raw = await image
    .clone()
    .resize(width, height, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    data: raw.data,
    width: raw.info.width,
    height: raw.info.height,
    channels: raw.info.channels,
    scaleX: originalWidth / raw.info.width,
    scaleY: originalHeight / raw.info.height,
    originalWidth,
    originalHeight
  };
}

async function refineOriginalHairlineEdges(image: sharp.Sharp, box: CropBox): Promise<CropBox> {
  const raw = await image
    .clone()
    .extract(box)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data, info } = raw;
  const channels = info.channels;
  const maxTrimX = Math.min(4, Math.floor(info.width * 0.01));
  const maxTrimY = Math.min(4, Math.floor(info.height * 0.01));
  let leftTrim = 0;
  let rightTrim = 0;
  let topTrim = 0;
  let bottomTrim = 0;

  const pixel = (x: number, y: number): Rgb => {
    const index = (y * info.width + x) * channels;
    return [data[index] ?? 0, data[index + 1] ?? 0, data[index + 2] ?? 0];
  };

  const lineStats = (axis: "x" | "y", value: number) => {
    const limit = axis === "x" ? info.height : info.width;
    const step = Math.max(1, Math.floor(limit / 220));
    const colors: Rgb[] = [];
    let avg: Rgb = [0, 0, 0];

    for (let i = 0; i < limit; i += step) {
      const color = axis === "x" ? pixel(value, i) : pixel(i, value);
      colors.push(color);
      avg = [avg[0] + color[0], avg[1] + color[1], avg[2] + color[2]];
    }

    avg = [avg[0] / colors.length, avg[1] / colors.length, avg[2] / colors.length];
    const spread = colors.reduce((sum, color) => sum + rgbDistance(color, avg), 0) / Math.max(1, colors.length);
    return { avg, spread, luma: luminance(avg) };
  };

  const isHairline = (axis: "x" | "y", value: number, direction: 1 | -1) => {
    const edge = lineStats(axis, value);
    const probeLimit = axis === "x" ? info.width - 1 : info.height - 1;
    const probe = lineStats(axis, clamp(value + direction * 3, 0, probeLimit));
    const pageLike = edge.spread < 10 && (edge.luma > 245 || edge.luma < 14);
    return pageLike && (rgbDistance(edge.avg, probe.avg) > 28 || probe.spread > 18);
  };

  while (leftTrim < maxTrimX && info.width - leftTrim - rightTrim > 8 && isHairline("x", leftTrim, 1)) leftTrim++;
  while (
    rightTrim < maxTrimX &&
    info.width - leftTrim - rightTrim > 8 &&
    isHairline("x", info.width - 1 - rightTrim, -1)
  ) {
    rightTrim++;
  }
  while (topTrim < maxTrimY && info.height - topTrim - bottomTrim > 8 && isHairline("y", topTrim, 1)) topTrim++;
  while (
    bottomTrim < maxTrimY &&
    info.height - topTrim - bottomTrim > 8 &&
    isHairline("y", info.height - 1 - bottomTrim, -1)
  ) {
    bottomTrim++;
  }

  if (!leftTrim && !rightTrim && !topTrim && !bottomTrim) return box;

  return {
    left: box.left + leftTrim,
    top: box.top + topTrim,
    width: box.width - leftTrim - rightTrim,
    height: box.height - topTrim - bottomTrim
  };
}

export async function cropXhsScreenshot(input: Buffer, filename: string): Promise<CropResult> {
  const image = sharp(input, { failOn: "none" }).rotate();
  const analysis = await createAnalysisImage(image).catch((error) => {
    throw new Error(error instanceof Error ? `${filename} ${error.message}` : `${filename} 无法识别`);
  });
  const detected = detectCropBox(analysis);
  const cropBox =
    detected.detector === "xhs-detail-media" || detected.detector === "xhs-detail-inner-trim"
      ? await refineOriginalHairlineEdges(image, detected.box)
      : detected.box;
  const extracted = await image
    .clone()
    .extract(cropBox)
    .jpeg({ quality: 94, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  return {
    id: crypto.randomUUID(),
    filename,
    mime: "image/jpeg",
    width: extracted.info.width,
    height: extracted.info.height,
    dataUrl: `data:image/jpeg;base64,${extracted.data.toString("base64")}`,
    cropBox,
    confidence: Number(detected.confidence.toFixed(2)),
    debug: {
      fallback: detected.fallback,
      detector: detected.detector,
      background: detected.background,
      candidates: detected.candidates
    }
  };
}
