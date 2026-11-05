/* ============================================================
   AI Todo · 轻量 QR Code 编码器（零第三方依赖）
   ------------------------------------------------------------
   用法：
     import { qrEncode, qrSvg, qrCanvas } from './qr.js';

     const qr = qrEncode('https://example.com', { ecc: 'M' });
     qr.size; qr.version; qr.mask; qr.get(x, y);

     box.innerHTML = qrSvg('https://example.com');
     box.appendChild(qrCanvas('https://example.com'));

   能力边界：Byte 模式（UTF-8）、版本 1–20、纠错等级 L/M/Q/H、
   8 种掩码 + 标准罚分规则、格式信息 BCH(15,5)、版本信息 BCH(18,6)。
   规范：ISO/IEC 18004。
   ============================================================ */

/* ---------------- GF(256) 与 Reed–Solomon ---------------- */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

/** 初始化 GF(256) 对数表，本原多项式 0x11D，生成元 2。 */
function initGfTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

initGfTables();

/** GF(256) 乘法。 */
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

const RS_GENERATORS = new Map();

/**
 * 生成 RS 生成多项式，降幂系数：gen[0] 是最高次项（恒为 1）。
 * 生成多项式 = ∏(x - 2^i)，i = 0 … degree-1。
 */
function rsGenerator(degree) {
  const cached = RS_GENERATORS.get(degree);
  if (cached) return cached;

  let asc = [1]; // 升幂：asc[d] 是 x^d 的系数
  for (let i = 0; i < degree; i++) {
    const next = new Array(asc.length + 1).fill(0);
    for (let d = 0; d < asc.length; d++) {
      next[d + 1] ^= asc[d]; // × x
      next[d] ^= gfMul(asc[d], GF_EXP[i]); // × 2^i
    }
    asc = next;
  }

  const gen = new Uint8Array(degree + 1);
  for (let d = 0; d <= degree; d++) gen[d] = asc[degree - d];
  RS_GENERATORS.set(degree, gen);
  return gen;
}

/**
 * 计算一块数据的 RS 纠错码字（长除法，生成多项式取自 rsGenerator）。
 */
function rsEncode(data, ecLength) {
  const gen = rsGenerator(ecLength);
  const buf = new Uint8Array(data.length + ecLength);
  buf.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i];
    if (factor === 0) continue;
    for (let j = 1; j <= ecLength; j++) {
      buf[i + j] ^= gfMul(gen[j], factor);
    }
  }
  return buf.subarray(data.length);
}

/* ---------------- 标准表 ---------------- */

/** 格式信息里的 2 位纠错等级指示：L=01, M=00, Q=11, H=10。 */
const ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

const MAX_VERSION = 20;

/**
 * RS 分块表（ISO/IEC 18004 表 13-22）。
 * 每项：[总码字数, 每块纠错码字数, 组1块数, 组1数据码字数, 组2块数, 组2数据码字数]
 */
const RS_BLOCKS = {
  1: { L: [26, 7, 1, 19, 0, 0], M: [26, 10, 1, 16, 0, 0], Q: [26, 13, 1, 13, 0, 0], H: [26, 17, 1, 9, 0, 0] },
  2: { L: [44, 10, 1, 34, 0, 0], M: [44, 16, 1, 28, 0, 0], Q: [44, 22, 1, 22, 0, 0], H: [44, 28, 1, 16, 0, 0] },
  3: { L: [70, 15, 1, 55, 0, 0], M: [70, 26, 1, 44, 0, 0], Q: [70, 18, 2, 17, 0, 0], H: [70, 22, 2, 13, 0, 0] },
  4: { L: [100, 20, 1, 80, 0, 0], M: [100, 18, 2, 32, 0, 0], Q: [100, 26, 2, 24, 0, 0], H: [100, 16, 4, 9, 0, 0] },
  5: { L: [134, 26, 1, 108, 0, 0], M: [134, 24, 2, 43, 0, 0], Q: [134, 18, 2, 15, 2, 16], H: [134, 22, 2, 11, 2, 12] },
  6: { L: [172, 18, 2, 68, 0, 0], M: [172, 16, 4, 27, 0, 0], Q: [172, 24, 4, 19, 0, 0], H: [172, 28, 4, 15, 0, 0] },
  7: { L: [196, 20, 2, 78, 0, 0], M: [196, 18, 4, 31, 0, 0], Q: [196, 18, 2, 14, 4, 15], H: [196, 26, 4, 13, 1, 14] },
  8: { L: [242, 24, 2, 97, 0, 0], M: [242, 22, 2, 38, 2, 39], Q: [242, 22, 4, 18, 2, 19], H: [242, 26, 4, 14, 2, 15] },
  9: { L: [292, 30, 2, 116, 0, 0], M: [292, 22, 3, 36, 2, 37], Q: [292, 20, 4, 16, 4, 17], H: [292, 24, 4, 12, 4, 13] },
  10: { L: [346, 18, 2, 68, 2, 69], M: [346, 26, 4, 43, 1, 44], Q: [346, 24, 6, 19, 2, 20], H: [346, 28, 6, 15, 2, 16] },
  11: { L: [404, 20, 4, 81, 0, 0], M: [404, 30, 1, 50, 4, 51], Q: [404, 28, 4, 22, 4, 23], H: [404, 24, 3, 12, 8, 13] },
  12: { L: [466, 24, 2, 92, 2, 93], M: [466, 22, 6, 36, 2, 37], Q: [466, 26, 4, 20, 6, 21], H: [466, 28, 7, 14, 4, 15] },
  13: { L: [532, 26, 4, 107, 0, 0], M: [532, 22, 8, 37, 1, 38], Q: [532, 24, 8, 20, 4, 21], H: [532, 22, 12, 11, 4, 12] },
  14: { L: [581, 30, 3, 115, 1, 116], M: [581, 24, 4, 40, 5, 41], Q: [581, 20, 11, 16, 5, 17], H: [581, 24, 11, 12, 5, 13] },
  15: { L: [655, 22, 5, 87, 1, 88], M: [655, 24, 5, 41, 5, 42], Q: [655, 30, 5, 24, 7, 25], H: [655, 24, 11, 12, 7, 13] },
  16: { L: [733, 24, 5, 98, 1, 99], M: [733, 28, 7, 45, 3, 46], Q: [733, 24, 15, 19, 2, 20], H: [733, 30, 3, 15, 13, 16] },
  17: { L: [815, 28, 1, 107, 5, 108], M: [815, 28, 10, 46, 1, 47], Q: [815, 28, 1, 22, 15, 23], H: [815, 28, 2, 14, 17, 15] },
  18: { L: [901, 30, 5, 120, 1, 121], M: [901, 26, 9, 43, 4, 44], Q: [901, 28, 17, 22, 1, 23], H: [901, 28, 2, 14, 19, 15] },
  19: { L: [991, 28, 3, 113, 4, 114], M: [991, 26, 3, 44, 11, 45], Q: [991, 26, 17, 21, 4, 22], H: [991, 26, 9, 13, 16, 14] },
  20: { L: [1085, 28, 3, 107, 5, 108], M: [1085, 26, 3, 41, 13, 42], Q: [1085, 30, 15, 24, 5, 25], H: [1085, 28, 15, 15, 10, 16] },
};

/** 校正图形中心坐标表（ISO/IEC 18004 表 E.1）。 */
const ALIGN_POSITIONS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
  11: [6, 30, 54],
  12: [6, 32, 58],
  13: [6, 34, 62],
  14: [6, 26, 46, 66],
  15: [6, 26, 48, 70],
  16: [6, 26, 50, 74],
  17: [6, 30, 54, 78],
  18: [6, 30, 56, 82],
  19: [6, 30, 58, 86],
  20: [6, 34, 62, 90],
};

/** 余数位（填充位）数量：版本 1 为 0，2–6 为 7，7–13 为 0，14–20 为 3。 */
function remainderBits(version) {
  if (version === 1) return 0;
  if (version <= 6) return 7;
  if (version <= 13) return 0;
  return 3;
}

/* ---------------- 位缓冲 ---------------- */

class BitWriter {
  constructor() {
    this.bytes = new Uint8Array(1024);
    this.length = 0; // 已写入位数
  }

  /** 写入 value 的低 bits 位（高位在前）。 */
  write(value, bits) {
    for (let i = bits - 1; i >= 0; i--) {
      const byteIndex = this.length >>> 3;
      if (byteIndex >= this.bytes.length) this.grow(byteIndex + 1);
      if ((value >>> i) & 1) this.bytes[byteIndex] |= 0x80 >>> (this.length & 7);
      this.length++;
    }
  }

  grow(minSize) {
    let size = this.bytes.length;
    while (size < minSize) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes);
    this.bytes = next;
  }

  toBytes() {
    return this.bytes.slice(0, Math.ceil(this.length / 8));
  }
}

/* ---------------- 编码流程 ---------------- */

/** 选版本：容量足够的最小版本。 */
function selectVersion(byteLength, ecc, minVersion, maxVersion) {
  const countBits = minVersion <= 9 ? 8 : 16;
  let best = null;
  let maxBytes = 0;

  for (let version = minVersion; version <= maxVersion; version++) {
    const spec = RS_BLOCKS[version][ecc];
    const dataCodewords = spec[2] * spec[3] + spec[4] * spec[5];
    const bytes = Math.floor((dataCodewords * 8 - 4 - countBits) / 8);
    if (bytes > maxBytes) maxBytes = bytes;
    if (byteLength * 8 + 4 + countBits <= dataCodewords * 8) {
      best = { version, spec };
      break;
    }
  }

  if (!best) {
    const needed = byteLength;
    throw new Error(
      `QR_CAPACITY_EXCEEDED: 需要 ${needed} 字节，版本 ${minVersion}-${maxVersion} 的 ${ecc} 级最多 ${maxBytes} 字节`,
    );
  }
  return best;
}

/** 生成数据码字：模式指示符 + 字符计数 + 数据 + 终止符 + 填充。 */
function encodeDataCodewords(bytes, version, dataCodewords) {
  const writer = new BitWriter();
  writer.write(0b0100, 4); // Byte 模式
  writer.write(bytes.length, version <= 9 ? 8 : 16); // 字符计数指示符
  for (let i = 0; i < bytes.length; i++) writer.write(bytes[i], 8);

  const capacityBits = dataCodewords * 8;
  writer.write(0, Math.min(4, capacityBits - writer.length)); // 终止符
  while (writer.length % 8 !== 0) writer.write(0, 1); // 补齐到字节边界
  let pad = 0xec;
  while (writer.length < capacityBits) {
    writer.write(pad, 8);
    pad = pad === 0xec ? 0x11 : 0xec;
  }
  return writer.toBytes();
}

/** 分块 + RS 纠错 + 交织，返回完整码字序列。 */
function buildCodewords(bytes, version, spec) {
  const [total, ecLength, g1Blocks, g1Data, g2Blocks, g2Data] = spec;
  const dataCodewords = encodeDataCodewords(bytes, version, g1Blocks * g1Data + g2Blocks * g2Data);

  const blocks = [];
  let offset = 0;
  for (let i = 0; i < g1Blocks; i++) {
    blocks.push(dataCodewords.slice(offset, offset + g1Data));
    offset += g1Data;
  }
  for (let i = 0; i < g2Blocks; i++) {
    blocks.push(dataCodewords.slice(offset, offset + g2Data));
    offset += g2Data;
  }

  const ecBlocks = blocks.map((block) => rsEncode(block, ecLength));

  const out = new Uint8Array(total);
  let pos = 0;
  const maxData = Math.max(g1Data, g2Blocks > 0 ? g2Data : 0);
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) {
      if (i < block.length) out[pos++] = block[i];
    }
  }
  for (let i = 0; i < ecLength; i++) {
    for (const block of ecBlocks) out[pos++] = block[i];
  }
  return out;
}

/** 格式信息位置（三份副本的全部模块坐标），用于预留功能图形区域。 */
function formatPositions(size) {
  const positions = [];
  // 第一份：左上角
  for (let i = 0; i <= 5; i++) positions.push([8, i]);
  positions.push([8, 7]);
  positions.push([8, 8]);
  positions.push([7, 8]);
  for (let i = 9; i < 15; i++) positions.push([14 - i, 8]);
  // 第二份：左下角（第 8 行，自右而左）
  for (let i = 0; i < 8; i++) positions.push([size - 1 - i, 8]);
  // 第三份：右上角（第 8 列，自下而上）
  for (let i = 8; i < 15; i++) positions.push([8, size - 15 + i]);
  return positions;
}

/** 版本信息位置（版本 ≥ 7）：左下与右上两块 3×6 区域。 */
function versionPositions(size) {
  const positions = [];
  for (let i = 0; i < 18; i++) {
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    positions.push([a, b]); // 右上
    positions.push([b, a]); // 左下
  }
  return positions;
}

/**
 * 构建功能图形 + 数据码字的底板矩阵（未加掩码）。
 * 返回 { size, modules, func }，func 标记功能图形区域（不参与掩码）。
 */
function buildBaseMatrix(version, codewords) {
  const size = 17 + 4 * version;
  const modules = new Uint8Array(size * size);
  const func = new Uint8Array(size * size);

  const setFunc = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y * size + x] = dark ? 1 : 0;
    func[y * size + x] = 1;
  };

  // 定位图形 + 分隔符（中心点周围 9×9，分隔符为最外一圈浅色）
  const drawFinder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFunc(cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  // 定时图形（第 6 行 / 第 6 列）
  for (let i = 8; i < size - 8; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }

  // 校正图形（跳过与三个定位图形重叠的组合）
  const positions = ALIGN_POSITIONS[version];
  for (const cy of positions) {
    for (const cx of positions) {
      if (cy === 6 && cx === 6) continue;
      if (cy === 6 && cx === size - 7) continue;
      if (cy === size - 7 && cx === 6) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          setFunc(cx + dx, cy + dy, dist !== 1);
        }
      }
    }
  }

  // 格式信息区（先占位成浅色，之后再写实际值）
  for (const [x, y] of formatPositions(size)) setFunc(x, y, false);
  // 固定深色模块
  setFunc(8, size - 8, true);

  // 版本信息区
  if (version >= 7) {
    for (const [x, y] of versionPositions(size)) setFunc(x, y, false);
  }

  // 数据码字：自右下角起，两列一组交替上下，跳过第 6 列
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = upward ? size - 1 - vert : vert;
        if (func[y * size + x]) continue;
        if (bitIndex >= totalBits) continue;
        modules[y * size + x] = (codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1;
        bitIndex++;
      }
    }
  }

  // 自检：可用模块数应等于「总码字数 × 8 + 余数位」
  let freeModules = 0;
  for (let i = 0; i < func.length; i++) if (!func[i]) freeModules++;
  const expected = codewords.length * 8 + remainderBits(version);
  if (freeModules !== expected) {
    throw new Error(`QR_INTERNAL_ERROR: 版本 ${version} 可用模块 ${freeModules}，期望 ${expected}`);
  }

  return { size, modules, func };
}

/** 掩码判定：i 为行、j 为列。 */
function maskBit(mask, x, y) {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/** 对非功能模块加掩码。 */
function applyMask(modules, func, size, mask) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (func[y * size + x]) continue;
      if (maskBit(mask, x, y)) modules[y * size + x] ^= 1;
    }
  }
}

/** 格式信息：5 位数据 + BCH(15,5)，再与 0b101010000010010 异或。 */
function formatBits(ecc, mask) {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** 版本信息：6 位版本号 + BCH(18,6)。 */
function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

/** 写入格式信息的三份副本与固定深色模块。 */
function drawFormatBits(modules, size, ecc, mask) {
  const bits = formatBits(ecc, mask);
  const bit = (i) => (bits >>> i) & 1;
  const put = (x, y, value) => {
    modules[y * size + x] = value;
  };

  // 第一份：左上角
  for (let i = 0; i <= 5; i++) put(8, i, bit(i));
  put(8, 7, bit(6));
  put(8, 8, bit(7));
  put(7, 8, bit(8));
  for (let i = 9; i < 15; i++) put(14 - i, 8, bit(i));

  // 第二份：左下角（第 8 行）
  for (let i = 0; i < 8; i++) put(size - 1 - i, 8, bit(i));

  // 第三份：右上角（第 8 列）
  for (let i = 8; i < 15; i++) put(8, size - 15 + i, bit(i));

  // 固定深色模块
  put(8, size - 8, 1);
}

/** 写入版本信息。 */
function drawVersionBits(modules, size, version) {
  if (version < 7) return;
  const bits = versionBits(version);
  const positions = versionPositions(size);
  for (let i = 0; i < 18; i++) {
    const bit = (bits >>> i) & 1;
    const [x1, y1] = positions[i * 2];
    const [x2, y2] = positions[i * 2 + 1];
    modules[y1 * size + x1] = bit;
    modules[y2 * size + x2] = bit;
  }
}

/* ---------------- 罚分 ---------------- */

const PATTERN_DARK_FIRST = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
const PATTERN_LIGHT_FIRST = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];

/** 单行/单列的罚分：N1（同色连续 5 个以上）+ N3（1:1:3:1:1 图样）。 */
function linePenalty(modules, size, index, isRow) {
  let score = 0;
  const at = (i) => (isRow ? modules[index * size + i] : modules[i * size + index]);

  // N1
  let run = 1;
  for (let i = 1; i < size; i++) {
    if (at(i) === at(i - 1)) {
      run++;
      if (run === 5) score += 3;
      else if (run > 5) score += 1;
    } else {
      run = 1;
    }
  }

  // N3：11 模块图样，深色起始或浅色起始各算一次
  for (let i = 0; i + 11 <= size; i++) {
    let darkFirst = true;
    let lightFirst = true;
    for (let k = 0; k < 11; k++) {
      const v = at(i + k);
      if (v !== PATTERN_DARK_FIRST[k]) darkFirst = false;
      if (v !== PATTERN_LIGHT_FIRST[k]) lightFirst = false;
      if (!darkFirst && !lightFirst) break;
    }
    if (darkFirst || lightFirst) score += 40;
  }

  return score;
}

/** 整体罚分：N1=3, N2=3, N3=40, N4=10。 */
function penaltyScore(modules, size) {
  let score = 0;
  for (let i = 0; i < size; i++) score += linePenalty(modules, size, i, true);
  for (let i = 0; i < size; i++) score += linePenalty(modules, size, i, false);

  // N2：2×2 同色块
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = modules[y * size + x];
      if (
        v === modules[y * size + x + 1] &&
        v === modules[(y + 1) * size + x] &&
        v === modules[(y + 1) * size + x + 1]
      ) {
        score += 3;
      }
    }
  }

  // N4：深色模块比例偏离 50% 越多罚分越高
  let dark = 0;
  for (let i = 0; i < modules.length; i++) dark += modules[i];
  const percent = (dark * 100) / (size * size);
  score += 10 * Math.floor(Math.abs(percent - 50) / 5);

  return score;
}

/* ---------------- 导出 API ---------------- */

/**
 * 编码为模块矩阵。
 * @param {string} text 待编码文本（按 UTF-8 编码）
 * @param {{ecc?: 'L'|'M'|'Q'|'H', minVersion?: number, maxVersion?: number, mask?: number|null}} options
 * @returns {{size: number, version: number, eccLevel: string, mask: number, modules: Uint8Array, get: (x: number, y: number) => boolean}}
 */
export function qrEncode(text, options = {}) {
  const ecc = options.ecc ?? 'M';
  const minVersion = options.minVersion ?? 1;
  const maxVersion = options.maxVersion ?? MAX_VERSION;
  const maskOption = options.mask ?? null;

  if (!Object.prototype.hasOwnProperty.call(ECC_FORMAT_BITS, ecc)) {
    throw new Error(`QR_INVALID_ECC: 纠错等级只能是 L/M/Q/H，收到 "${ecc}"`);
  }
  if (!Number.isInteger(minVersion) || !Number.isInteger(maxVersion)) {
    throw new Error('QR_INVALID_VERSION: 版本号必须是整数');
  }
  if (minVersion < 1 || maxVersion > MAX_VERSION || minVersion > maxVersion) {
    throw new Error(`QR_INVALID_VERSION: 版本范围必须是 1-${MAX_VERSION}`);
  }
  if (maskOption !== null && (!Number.isInteger(maskOption) || maskOption < 0 || maskOption > 7)) {
    throw new Error('QR_INVALID_MASK: 掩码必须是 0-7 或 null');
  }

  const bytes = new TextEncoder().encode(String(text));
  const { version, spec } = selectVersion(bytes.length, ecc, minVersion, maxVersion);
  const codewords = buildCodewords(bytes, version, spec);
  const base = buildBaseMatrix(version, codewords);

  const candidates = maskOption === null ? [0, 1, 2, 3, 4, 5, 6, 7] : [maskOption];
  let best = null;
  for (const mask of candidates) {
    const modules = base.modules.slice();
    applyMask(modules, base.func, base.size, mask);
    drawFormatBits(modules, base.size, ecc, mask);
    drawVersionBits(modules, base.size, version);
    const score = penaltyScore(modules, base.size);
    if (!best || score < best.score) best = { mask, score, modules };
  }

  const size = base.size;
  const modules = best.modules;
  return {
    size,
    version,
    eccLevel: ecc,
    mask: best.mask,
    modules,
    get(x, y) {
      if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
      if (x < 0 || y < 0 || x >= size || y >= size) return false;
      return modules[y * size + x] === 1;
    },
  };
}

/**
 * 渲染为 SVG 字符串（深色 #000000、浅色 #ffffff、静区 4 个模块）。
 * 额外支持可选参数 scale（像素/模块，默认 8）与 margin（静区模块数，默认 4）。
 * @param {string} text
 * @param {object} options 同 qrEncode
 * @returns {string}
 */
export function qrSvg(text, options = {}) {
  const qr = qrEncode(text, options);
  const margin = options.margin ?? 4;
  const scale = options.scale ?? 8;
  const size = qr.size;
  const dimension = size + margin * 2;

  const path = [];
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!qr.get(x, y)) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < size && qr.get(x + run, y)) run++;
      path.push(`M${x + margin} ${y + margin}h${run}v1h-${run}z`);
      x += run;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dimension} ${dimension}" ` +
    `width="${dimension * scale}" height="${dimension * scale}" shape-rendering="crispEdges" ` +
    `role="img" aria-label="QR Code">` +
    `<rect width="${dimension}" height="${dimension}" fill="#ffffff"/>` +
    `<path d="${path.join('')}" fill="#000000"/>` +
    `</svg>`
  );
}

/**
 * 渲染到 canvas（浏览器环境），返回 canvas 元素。
 * 额外支持可选参数 scale（像素/模块，默认 8）与 margin（静区模块数，默认 4）。
 * @param {string} text
 * @param {object} options 同 qrEncode
 * @returns {HTMLCanvasElement}
 */
export function qrCanvas(text, options = {}) {
  if (typeof document === 'undefined') {
    throw new Error('QR_NO_CANVAS: qrCanvas 只能在浏览器环境使用');
  }
  const qr = qrEncode(text, options);
  const margin = options.margin ?? 4;
  const scale = options.scale ?? 8;
  const dimension = qr.size + margin * 2;

  const canvas = document.createElement('canvas');
  canvas.width = dimension * scale;
  canvas.height = dimension * scale;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('QR_NO_CANVAS: 无法获取 2D 绘图上下文');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.get(x, y)) ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
    }
  }
  return canvas;
}
