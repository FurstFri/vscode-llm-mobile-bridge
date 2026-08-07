/**
 * A dependency-free QR encoder, byte mode only. The extension has to turn a
 * pairing payload into something a phone camera can read without shipping a
 * runtime dependency or calling a rendering service, so the ISO/IEC 18004
 * algorithm lives here.
 */

export type QrErrorCorrection = "L" | "M" | "Q" | "H";

export interface QrCode {
  readonly version: number;
  readonly size: number;
  readonly errorCorrection: QrErrorCorrection;
  /** Row-major matrix; `true` is a dark module. */
  readonly modules: readonly (readonly boolean[])[];
}

export interface QrSvgOptions {
  moduleSize?: number;
  quietZone?: number;
  dark?: string;
  light?: string;
}

const FORMAT_BITS: Record<QrErrorCorrection, number> = { L: 1, M: 0, Q: 3, H: 2 };
const LEVELS: readonly QrErrorCorrection[] = ["L", "M", "Q", "H"];
const MIN_VERSION = 1;
const MAX_VERSION = 40;

// Standard ISO/IEC 18004 tables, indexed by [level][version] with a leading
// placeholder so the version number indexes directly.
const ECC_CODEWORDS_PER_BLOCK: Record<QrErrorCorrection, readonly number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};

const ECC_BLOCKS: Record<QrErrorCorrection, readonly number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

/**
 * Encodes `text` at the strongest error correction level that still fits the
 * smallest possible symbol, so a payload gets the most redundancy it can have
 * for free.
 */
export function encodeQr(text: string, minimum: QrErrorCorrection = "L"): QrCode {
  const data = [...new TextEncoder().encode(text)];
  const floor = LEVELS.indexOf(minimum);
  if (floor < 0) throw new Error(`Unknown error correction level: ${minimum}`);

  for (let version = MIN_VERSION; version <= MAX_VERSION; version += 1) {
    for (let level = LEVELS.length - 1; level >= floor; level -= 1) {
      const errorCorrection = LEVELS[level] as QrErrorCorrection;
      if (!fits(data.length, version, errorCorrection)) continue;
      return build(data, version, errorCorrection);
    }
  }
  throw new Error("The payload does not fit in a QR symbol");
}

export function qrToSvg(code: QrCode, options: QrSvgOptions = {}): string {
  const moduleSize = options.moduleSize ?? 6;
  const quietZone = options.quietZone ?? 4;
  const side = (code.size + quietZone * 2) * moduleSize;
  const parts: string[] = [];
  for (let y = 0; y < code.size; y += 1) {
    for (let x = 0; x < code.size; x += 1) {
      if (!code.modules[y]?.[x]) continue;
      parts.push(`M${(x + quietZone) * moduleSize} ${(y + quietZone) * moduleSize}h${moduleSize}v${moduleSize}h-${moduleSize}z`);
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges">`,
    `<rect width="${side}" height="${side}" fill="${options.light ?? "#ffffff"}"/>`,
    `<path fill="${options.dark ?? "#000000"}" d="${parts.join("")}"/>`,
    "</svg>",
  ].join("");
}

function fits(byteLength: number, version: number, level: QrErrorCorrection): boolean {
  const capacityBits = dataCodewords(version, level) * 8;
  const usedBits = 4 + characterCountBits(version) + byteLength * 8;
  return usedBits <= capacityBits;
}

function characterCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

function build(data: readonly number[], version: number, level: QrErrorCorrection): QrCode {
  const codewords = interleave(toDataCodewords(data, version, level), version, level);
  const size = version * 4 + 17;
  const modules = createMatrix(size);
  const reserved = createMatrix(size);

  drawFunctionPatterns(modules, reserved, version, size);
  drawCodewords(modules, reserved, codewords, size);

  let bestMask = 0;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    applyMask(modules, reserved, mask, size);
    drawFormatBits(modules, reserved, level, mask, size);
    const penalty = penaltyScore(modules, size);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
    applyMask(modules, reserved, mask, size);
  }
  applyMask(modules, reserved, bestMask, size);
  drawFormatBits(modules, reserved, level, bestMask, size);

  return { version, size, errorCorrection: level, modules };
}

function createMatrix(size: number): boolean[][] {
  return Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
}

function dataCodewords(version: number, level: QrErrorCorrection): number {
  const blocks = ECC_BLOCKS[level][version] as number;
  const eccPerBlock = ECC_CODEWORDS_PER_BLOCK[level][version] as number;
  return Math.floor(rawDataModules(version) / 8) - eccPerBlock * blocks;
}

function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignCount = Math.floor(version / 7) + 2;
    result -= (25 * alignCount - 10) * alignCount - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function toDataCodewords(data: readonly number[], version: number, level: QrErrorCorrection): number[] {
  const bits: number[] = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, data.length, characterCountBits(version));
  for (const byte of data) appendBits(bits, byte, 8);

  const capacity = dataCodewords(version, level) * 8;
  appendBits(bits, 0, Math.min(4, capacity - bits.length));
  appendBits(bits, 0, (8 - bits.length % 8) % 8);

  const codewords: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) value = value << 1 | (bits[index + bit] as number);
    codewords.push(value);
  }
  for (let pad = 0xEC; codewords.length * 8 < capacity; pad ^= 0xEC ^ 0x11) codewords.push(pad);
  return codewords;
}

function appendBits(bits: number[], value: number, length: number): void {
  for (let index = length - 1; index >= 0; index -= 1) bits.push(value >>> index & 1);
}

function interleave(data: readonly number[], version: number, level: QrErrorCorrection): number[] {
  const blockCount = ECC_BLOCKS[level][version] as number;
  const eccPerBlock = ECC_CODEWORDS_PER_BLOCK[level][version] as number;
  const totalCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blockCount - totalCodewords % blockCount;
  const shortLength = Math.floor(totalCodewords / blockCount) - eccPerBlock;

  const generator = reedSolomonGenerator(eccPerBlock);
  const blocks: number[][] = [];
  const eccBlocks: number[][] = [];
  let offset = 0;
  for (let index = 0; index < blockCount; index += 1) {
    const length = shortLength + (index < shortBlocks ? 0 : 1);
    const block = data.slice(offset, offset + length);
    offset += length;
    blocks.push(block);
    eccBlocks.push(reedSolomonRemainder(block, generator));
  }

  const result: number[] = [];
  for (let index = 0; index < shortLength + 1; index += 1) {
    for (let block = 0; block < blockCount; block += 1) {
      const codeword = blocks[block]?.[index];
      if (codeword !== undefined) result.push(codeword);
    }
  }
  for (let index = 0; index < eccPerBlock; index += 1) {
    for (let block = 0; block < blockCount; block += 1) result.push(eccBlocks[block]?.[index] as number);
  }
  return result;
}

function reedSolomonGenerator(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let index = 0; index < degree; index += 1) {
    for (let position = 0; position < degree; position += 1) {
      result[position] = multiply(result[position] as number, root);
      if (position + 1 < degree) result[position] ^= result[position + 1] as number;
    }
    root = multiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data: readonly number[], generator: readonly number[]): number[] {
  const result = new Array<number>(generator.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number);
    result.push(0);
    for (let index = 0; index < generator.length; index += 1) {
      result[index] ^= multiply(generator[index] as number, factor);
    }
  }
  return result;
}

/** Carry-less multiply over GF(2^8) with the QR primitive polynomial. */
function multiply(left: number, right: number): number {
  let result = 0;
  for (let bit = 7; bit >= 0; bit -= 1) {
    result = result << 1 ^ (result >>> 7) * 0x11D;
    result ^= (right >>> bit & 1) * left;
  }
  return result & 0xFF;
}

function drawFunctionPatterns(
  modules: boolean[][],
  reserved: boolean[][],
  version: number,
  size: number,
): void {
  for (let index = 0; index < size; index += 1) {
    setFunction(modules, reserved, 6, index, index % 2 === 0);
    setFunction(modules, reserved, index, 6, index % 2 === 0);
  }

  drawFinder(modules, reserved, 3, 3, size);
  drawFinder(modules, reserved, size - 4, 3, size);
  drawFinder(modules, reserved, 3, size - 4, size);

  const alignments = alignmentPositions(version);
  for (let row = 0; row < alignments.length; row += 1) {
    for (let column = 0; column < alignments.length; column += 1) {
      const skipsFinder = (row === 0 && column === 0)
        || (row === 0 && column === alignments.length - 1)
        || (row === alignments.length - 1 && column === 0);
      if (skipsFinder) continue;
      drawAlignment(modules, reserved, alignments[column] as number, alignments[row] as number);
    }
  }

  drawFormatBits(modules, reserved, "L", 0, size);
  drawVersionBits(modules, reserved, version, size);
}

function drawFinder(modules: boolean[][], reserved: boolean[][], x: number, y: number, size: number): void {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      const px = x + dx;
      const py = y + dy;
      if (px < 0 || px >= size || py < 0 || py >= size) continue;
      setFunction(modules, reserved, px, py, distance !== 2 && distance !== 4);
    }
  }
}

function drawAlignment(modules: boolean[][], reserved: boolean[][], x: number, y: number): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      setFunction(modules, reserved, x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let position = version * 4 + 10; result.length < count; position -= step) result.splice(1, 0, position);
  return result;
}

function drawFormatBits(
  modules: boolean[][],
  reserved: boolean[][],
  level: QrErrorCorrection,
  mask: number,
  size: number,
): void {
  const data = FORMAT_BITS[level] << 3 | mask;
  let remainder = data;
  for (let index = 0; index < 10; index += 1) remainder = remainder << 1 ^ (remainder >>> 9) * 0x537;
  const bits = (data << 10 | remainder) ^ 0x5412;

  for (let index = 0; index <= 5; index += 1) setFunction(modules, reserved, 8, index, bit(bits, index));
  setFunction(modules, reserved, 8, 7, bit(bits, 6));
  setFunction(modules, reserved, 8, 8, bit(bits, 7));
  setFunction(modules, reserved, 7, 8, bit(bits, 8));
  for (let index = 9; index < 15; index += 1) setFunction(modules, reserved, 14 - index, 8, bit(bits, index));

  for (let index = 0; index < 8; index += 1) setFunction(modules, reserved, size - 1 - index, 8, bit(bits, index));
  for (let index = 8; index < 15; index += 1) setFunction(modules, reserved, 8, size - 15 + index, bit(bits, index));
  setFunction(modules, reserved, 8, size - 8, true);
}

function drawVersionBits(modules: boolean[][], reserved: boolean[][], version: number, size: number): void {
  if (version < 7) return;
  let remainder = version;
  for (let index = 0; index < 12; index += 1) remainder = remainder << 1 ^ (remainder >>> 11) * 0x1F25;
  const bits = version << 12 | remainder;
  for (let index = 0; index < 18; index += 1) {
    const value = bit(bits, index);
    const a = size - 11 + index % 3;
    const b = Math.floor(index / 3);
    setFunction(modules, reserved, a, b, value);
    setFunction(modules, reserved, b, a, value);
  }
}

function drawCodewords(
  modules: boolean[][],
  reserved: boolean[][],
  codewords: readonly number[],
  size: number,
): void {
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - step : step;
        if (reserved[y]?.[x]) continue;
        const byte = codewords[index >>> 3];
        (modules[y] as boolean[])[x] = byte !== undefined && (byte >>> (7 - (index & 7)) & 1) !== 0;
        index += 1;
      }
    }
  }
}

function applyMask(modules: boolean[][], reserved: boolean[][], mask: number, size: number): void {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (reserved[y]?.[x]) continue;
      if (!maskBit(mask, x, y)) continue;
      (modules[y] as boolean[])[x] = !(modules[y] as boolean[])[x];
    }
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return x * y % 2 + x * y % 3 === 0;
    case 6: return (x * y % 2 + x * y % 3) % 2 === 0;
    default: return ((x + y) % 2 + x * y % 3) % 2 === 0;
  }
}

function penaltyScore(modules: readonly boolean[][], size: number): number {
  let result = 0;

  for (let y = 0; y < size; y += 1) {
    let runColour = false;
    let runLength = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let x = 0; x < size; x += 1) {
      const module = modules[y]?.[x] === true;
      if (module === runColour) {
        runLength += 1;
        if (runLength === 5) result += 3;
        else if (runLength > 5) result += 1;
      } else {
        pushRun(history, runLength, runColour, modules[y] as boolean[], size);
        if (!runColour) result += finderPenalty(history) * 40;
        runColour = module;
        runLength = 1;
      }
    }
    result += finderPenaltyEnd(history, runLength, runColour, size) * 40;
  }

  for (let x = 0; x < size; x += 1) {
    let runColour = false;
    let runLength = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let y = 0; y < size; y += 1) {
      const module = modules[y]?.[x] === true;
      if (module === runColour) {
        runLength += 1;
        if (runLength === 5) result += 3;
        else if (runLength > 5) result += 1;
      } else {
        pushRunColumn(history, runLength, runColour, modules, x, size);
        if (!runColour) result += finderPenalty(history) * 40;
        runColour = module;
        runLength = 1;
      }
    }
    result += finderPenaltyEndColumn(history, runLength, runColour, size) * 40;
  }

  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const module = modules[y]?.[x];
      if (
        module === modules[y]?.[x + 1]
        && module === modules[y + 1]?.[x]
        && module === modules[y + 1]?.[x + 1]
      ) result += 3;
    }
  }

  let dark = 0;
  for (const row of modules) for (const module of row) if (module) dark += 1;
  const total = size * size;
  const deviation = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  return result + deviation * 10;
}

function pushRun(history: number[], runLength: number, runColour: boolean, row: boolean[], size: number): void {
  if (history[0] === 0 && !runColour) runLength += size;
  addHistory(history, runLength);
  void row;
}

function pushRunColumn(
  history: number[],
  runLength: number,
  runColour: boolean,
  modules: readonly boolean[][],
  x: number,
  size: number,
): void {
  if (history[0] === 0 && !runColour) runLength += size;
  addHistory(history, runLength);
  void modules;
  void x;
}

function finderPenaltyEnd(history: number[], runLength: number, runColour: boolean, size: number): number {
  if (runColour) {
    addHistory(history, runLength);
    runLength = 0;
  }
  runLength += size;
  addHistory(history, runLength);
  return finderPenalty(history);
}

function finderPenaltyEndColumn(history: number[], runLength: number, runColour: boolean, size: number): number {
  return finderPenaltyEnd(history, runLength, runColour, size);
}

function addHistory(history: number[], runLength: number): void {
  history.pop();
  history.unshift(runLength);
}

/** Counts the 1:1:3:1:1 finder-lookalike patterns the standard penalises. */
function finderPenalty(history: readonly number[]): number {
  const n = history[1] as number;
  const core = n > 0
    && history[2] === n
    && history[3] === n * 3
    && history[4] === n
    && history[5] === n;
  if (!core) return 0;
  return ((history[0] as number) >= n * 4 ? 1 : 0) + ((history[6] as number) >= n * 4 ? 1 : 0);
}

function bit(value: number, index: number): boolean {
  return (value >>> index & 1) !== 0;
}

function setFunction(modules: boolean[][], reserved: boolean[][], x: number, y: number, dark: boolean): void {
  const row = modules[y];
  const reservedRow = reserved[y];
  if (!row || !reservedRow || x < 0 || x >= row.length) return;
  row[x] = dark;
  reservedRow[x] = true;
}
