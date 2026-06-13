const GIF_TRANSPARENCY_INDEX = 255;
const GLOBAL_PALETTE = buildPalette();

export function isAnimatedWebP(arrayBuffer) {
  try {
    const structure = parseWebPStructure(arrayBuffer);
    return structure.frames.length > 0;
  } catch {
    return false;
  }
}

export function parseWebPStructure(arrayBuffer) {
  const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  assertWebPHeader(bytes);

  let canvasWidth = 0;
  let canvasHeight = 0;
  let backgroundColor = [0, 0, 0, 0];
  let loopCount = 0;
  let animationFlag = false;
  const frames = [];

  for (const chunk of iterateChunks(bytes, 12, bytes.length)) {
    if (chunk.fourCC === "VP8X") {
      const flags = chunk.payload[0];
      animationFlag = (flags & 0x02) !== 0;
      canvasWidth = readUint24(chunk.payload, 4) + 1;
      canvasHeight = readUint24(chunk.payload, 7) + 1;
    } else if (chunk.fourCC === "ANIM") {
      backgroundColor = readBackgroundColor(chunk.payload);
      loopCount = readUint16(chunk.payload, 4);
    } else if (chunk.fourCC === "ANMF") {
      const frame = parseAnimationFrame(bytes, chunk);
      frames.push(frame);
    } else if ((chunk.fourCC === "VP8 " || chunk.fourCC === "VP8L") && !canvasWidth && !canvasHeight) {
      const dimensions = inferBitstreamDimensions(chunk.fourCC, chunk.payload);
      canvasWidth = dimensions.width;
      canvasHeight = dimensions.height;
    }
  }

  return {
    canvasWidth,
    canvasHeight,
    backgroundColor,
    loopCount,
    animationFlag,
    frames
  };
}

export async function convertAnimatedWebPToGif(arrayBuffer, onProgress = () => {}) {
  const structure = parseWebPStructure(arrayBuffer);
  if (!structure.frames.length) {
    throw new Error("アニメーション WebP のフレームが見つかりませんでした。");
  }

  const composeCanvas = createCanvas(structure.canvasWidth, structure.canvasHeight);
  const composeContext = composeCanvas.getContext("2d", { willReadFrequently: true });
  paintCanvas(composeContext, structure.canvasWidth, structure.canvasHeight, structure.backgroundColor);

  const snapshots = [];
  let previousFrame = null;

  for (let index = 0; index < structure.frames.length; index += 1) {
    const frame = structure.frames[index];
    if (previousFrame) {
      applyFrameDisposal(composeContext, previousFrame, structure.backgroundColor);
    }

    if (frame.blend === 1) {
      composeContext.clearRect(frame.x, frame.y, frame.width, frame.height);
    }

    onProgress(0.04 + (index / structure.frames.length) * 0.16, `フレーム ${index + 1}/${structure.frames.length} を読み込んでいます`);
    const bitmap = await decodeStillWebP(frame.bytes);
    composeContext.drawImage(bitmap, frame.x, frame.y, frame.width, frame.height);
    if (typeof bitmap.close === "function") {
      bitmap.close();
    }

    snapshots.push({
      imageData: composeContext.getImageData(0, 0, structure.canvasWidth, structure.canvasHeight),
      duration: frame.duration
    });

    previousFrame = frame;
    onProgress(0.2 + ((index + 1) / structure.frames.length) * 0.28, `フレーム ${index + 1}/${structure.frames.length} を合成しました`);
    await nextFrame();
  }

  const gifBytes = await rgbaFramesToGifBytes(
    snapshots,
    structure.canvasWidth,
    structure.canvasHeight,
    structure.loopCount,
    (progress, label) => {
      onProgress(0.48 + progress * 0.52, label);
    }
  );

  onProgress(1, "完成しました");
  return new Blob([gifBytes], { type: "image/gif" });
}

export async function rgbaToGifBlob({ data, width, height }, onProgress = () => {}) {
  const gifBytes = await rgbaFramesToGifBytes(
    [{ imageData: { data, width, height }, duration: 0 }],
    width,
    height,
    0,
    onProgress
  );
  return new Blob([gifBytes], { type: "image/gif" });
}

export async function rgbaToGifBytes({ data, width, height }, onProgress = () => {}) {
  return rgbaFramesToGifBytes(
    [{ imageData: { data, width, height }, duration: 0 }],
    width,
    height,
    0,
    onProgress
  );
}

export async function rgbaFramesToGifBytes(frames, width, height, loopCount = 0, onProgress = () => {}) {
  const stream = new ByteStream();
  stream.writeAscii("GIF89a");
  stream.writeShort(width);
  stream.writeShort(height);
  stream.writeByte(0xf7);
  stream.writeByte(0x00);
  stream.writeByte(GIF_TRANSPARENCY_INDEX);

  for (const [red, green, blue] of GLOBAL_PALETTE) {
    stream.writeByte(red);
    stream.writeByte(green);
    stream.writeByte(blue);
  }

  writeLoopingExtension(stream, loopCount);

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const indexedPixels = await quantizePixels(frame.imageData, (progress) => {
      onProgress(
        ((index + progress * 0.55) / frames.length),
        `フレーム ${index + 1}/${frames.length} の色を整理しています`
      );
    });

    const delay = millisecondsToGifDelay(frame.duration);
    writeGraphicControlExtension(stream, delay);
    writeImageDescriptor(stream, width, height);

    const compressed = lzwEncode(indexedPixels, 8, (progress) => {
      onProgress(
        ((index + 0.55 + progress * 0.45) / frames.length),
        `フレーム ${index + 1}/${frames.length} を圧縮しています`
      );
    });

    stream.writeByte(8);
    let offset = 0;
    while (offset < compressed.length) {
      const chunkLength = Math.min(255, compressed.length - offset);
      stream.writeByte(chunkLength);
      stream.writeBytes(compressed.subarray(offset, offset + chunkLength));
      offset += chunkLength;
    }
    stream.writeByte(0x00);
    await nextFrame();
  }

  stream.writeByte(0x3b);
  return stream.toUint8Array();
}

async function quantizePixels(imageData, onProgress) {
  const { data, width, height } = imageData;
  const indexed = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelOffset = (y * width + x) * 4;
      const alpha = data[pixelOffset + 3];
      indexed[y * width + x] = alpha < 16
        ? GIF_TRANSPARENCY_INDEX
        : mapToPaletteIndex(data[pixelOffset], data[pixelOffset + 1], data[pixelOffset + 2]);
    }

    if (y % 12 === 0 || y === height - 1) {
      onProgress((y + 1) / height);
      await nextFrame();
    }
  }

  return indexed;
}

function lzwEncode(indices, minCodeSize, onProgress) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let nextCode = endCode + 1;
  let codeSize = minCodeSize + 1;
  let dictionary = createInitialDictionary(clearCode);
  let phrase = `${indices[0]}`;

  const output = new BitWriter();
  output.write(clearCode, codeSize);

  for (let index = 1; index < indices.length; index += 1) {
    const symbol = `${indices[index]}`;
    const composite = `${phrase},${symbol}`;

    if (dictionary.has(composite)) {
      phrase = composite;
    } else {
      output.write(dictionary.get(phrase), codeSize);

      if (nextCode < 4096) {
        dictionary.set(composite, nextCode);
        nextCode += 1;
        if (nextCode === (1 << codeSize) && codeSize < 12) {
          codeSize += 1;
        }
      } else {
        output.write(clearCode, codeSize);
        dictionary = createInitialDictionary(clearCode);
        codeSize = minCodeSize + 1;
        nextCode = endCode + 1;
      }

      phrase = symbol;
    }

    if (index % 5000 === 0) {
      onProgress(index / indices.length);
    }
  }

  output.write(dictionary.get(phrase), codeSize);
  output.write(endCode, codeSize);
  onProgress(1);
  return output.finish();
}

function parseAnimationFrame(bytes, chunk) {
  const payload = bytes.subarray(chunk.payloadStart, chunk.payloadEnd);
  const x = readUint24(payload, 0) * 2;
  const y = readUint24(payload, 3) * 2;
  const width = readUint24(payload, 6) + 1;
  const height = readUint24(payload, 9) + 1;
  const duration = readUint24(payload, 12);
  const flags = payload[15];
  const blend = (flags & 0x02) !== 0 ? 1 : 0;
  const dispose = (flags & 0x01) !== 0 ? 1 : 0;

  let alphaChunk = null;
  let imageChunk = null;

  for (const subchunk of iterateChunks(bytes, chunk.payloadStart + 16, chunk.payloadEnd)) {
    if (subchunk.fourCC === "ALPH") {
      alphaChunk = bytes.slice(subchunk.start, subchunk.end);
    } else if (subchunk.fourCC === "VP8 " || subchunk.fourCC === "VP8L") {
      imageChunk = bytes.slice(subchunk.start, subchunk.end);
    }
  }

  if (!imageChunk) {
    throw new Error("アニメーション WebP のフレーム画像を読み出せませんでした。");
  }

  return {
    x,
    y,
    width,
    height,
    duration,
    blend,
    dispose,
    bytes: buildStillWebPFrame(width, height, alphaChunk, imageChunk)
  };
}

function buildStillWebPFrame(width, height, alphaChunk, imageChunk) {
  const imageType = readFourCC(imageChunk, 0);
  if (!alphaChunk && imageType === "VP8L") {
    return buildRiffWebP([imageChunk]);
  }

  if (!alphaChunk && imageType === "VP8 ") {
    return buildRiffWebP([imageChunk]);
  }

  const vp8xChunk = buildChunk("VP8X", buildVP8XPayload(width, height, Boolean(alphaChunk)));
  return buildRiffWebP(alphaChunk ? [vp8xChunk, alphaChunk, imageChunk] : [vp8xChunk, imageChunk]);
}

function buildVP8XPayload(width, height, hasAlpha) {
  const payload = new Uint8Array(10);
  payload[0] = hasAlpha ? 0x10 : 0x00;
  writeUint24(payload, 4, width - 1);
  writeUint24(payload, 7, height - 1);
  return payload;
}

function buildRiffWebP(chunks) {
  const totalChunkBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const riffPayloadSize = 4 + totalChunkBytes;
  const bytes = new Uint8Array(8 + riffPayloadSize);
  writeAscii(bytes, 0, "RIFF");
  writeUint32(bytes, 4, riffPayloadSize);
  writeAscii(bytes, 8, "WEBP");

  let offset = 12;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return bytes;
}

function buildChunk(fourCC, payload) {
  const paddedLength = payload.length + (payload.length % 2);
  const chunk = new Uint8Array(8 + paddedLength);
  writeAscii(chunk, 0, fourCC);
  writeUint32(chunk, 4, payload.length);
  chunk.set(payload, 8);
  return chunk;
}

async function decodeStillWebP(bytes) {
  const blob = new Blob([bytes], { type: "image/webp" });
  if ("createImageBitmap" in globalThis) {
    return createImageBitmap(blob);
  }

  return new Promise((resolve, reject) => {
    const imageURL = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(imageURL);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(imageURL);
      reject(new Error("アニメーション WebP のフレームを読み込めませんでした。"));
    };
    image.src = imageURL;
  });
}

function iterateChunks(bytes, startOffset, endOffset) {
  const chunks = [];
  let offset = startOffset;

  while (offset + 8 <= endOffset) {
    const fourCC = readFourCC(bytes, offset);
    const size = readUint32(bytes, offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + size;
    const paddedSize = size + (size % 2);
    const end = payloadStart + paddedSize;

    if (payloadEnd > endOffset || end > bytes.length) {
      break;
    }

    chunks.push({
      fourCC,
      size,
      start: offset,
      end,
      payloadStart,
      payloadEnd,
      payload: bytes.subarray(payloadStart, payloadEnd)
    });

    offset = end;
  }

  return chunks;
}

function assertWebPHeader(bytes) {
  if (readFourCC(bytes, 0) !== "RIFF" || readFourCC(bytes, 8) !== "WEBP") {
    throw new Error("WebP ファイルとして読み取れませんでした。");
  }
}

function inferBitstreamDimensions(fourCC, payload) {
  if (fourCC === "VP8L") {
    if (payload[0] !== 0x2f) {
      throw new Error("VP8L ヘッダーを読み取れませんでした。");
    }

    const bits =
      payload[1] |
      (payload[2] << 8) |
      (payload[3] << 16) |
      (payload[4] << 24);

    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1
    };
  }

  const width = payload[6] | (payload[7] << 8);
  const height = payload[8] | (payload[9] << 8);
  return {
    width: width & 0x3fff,
    height: height & 0x3fff
  };
}

function readBackgroundColor(payload) {
  return [payload[2], payload[1], payload[0], payload[3]];
}

function applyFrameDisposal(context, frame, backgroundColor) {
  if (frame.dispose !== 1) {
    return;
  }

  if (backgroundColor[3] === 0) {
    context.clearRect(frame.x, frame.y, frame.width, frame.height);
    return;
  }

  context.save();
  context.fillStyle = rgbaToCss(backgroundColor);
  context.fillRect(frame.x, frame.y, frame.width, frame.height);
  context.restore();
}

function paintCanvas(context, width, height, backgroundColor) {
  context.clearRect(0, 0, width, height);
  if (backgroundColor[3] === 0) {
    return;
  }

  context.save();
  context.fillStyle = rgbaToCss(backgroundColor);
  context.fillRect(0, 0, width, height);
  context.restore();
}

function rgbaToCss([red, green, blue, alpha]) {
  return `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
}

function createCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function millisecondsToGifDelay(duration) {
  return Math.max(2, Math.round(duration / 10));
}

function writeLoopingExtension(stream, loopCount) {
  stream.writeBytes([
    0x21, 0xff, 0x0b,
    0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30,
    0x03, 0x01
  ]);
  stream.writeShort(loopCount);
  stream.writeByte(0x00);
}

function writeGraphicControlExtension(stream, delay) {
  stream.writeBytes([
    0x21, 0xf9, 0x04,
    0x01
  ]);
  stream.writeShort(delay);
  stream.writeByte(GIF_TRANSPARENCY_INDEX);
  stream.writeByte(0x00);
}

function writeImageDescriptor(stream, width, height) {
  stream.writeByte(0x2c);
  stream.writeShort(0);
  stream.writeShort(0);
  stream.writeShort(width);
  stream.writeShort(height);
  stream.writeByte(0x00);
}

function createInitialDictionary(clearCode) {
  const dictionary = new Map();
  for (let code = 0; code < clearCode; code += 1) {
    dictionary.set(`${code}`, code);
  }
  return dictionary;
}

function buildPalette() {
  const colors = [];
  for (let red = 0; red < 6; red += 1) {
    for (let green = 0; green < 7; green += 1) {
      for (let blue = 0; blue < 6; blue += 1) {
        colors.push([
          Math.round((red / 5) * 255),
          Math.round((green / 6) * 255),
          Math.round((blue / 5) * 255)
        ]);
      }
    }
  }

  while (colors.length < GIF_TRANSPARENCY_INDEX) {
    colors.push([0, 0, 0]);
  }

  colors.push([0, 0, 0]);
  return colors;
}

function mapToPaletteIndex(red, green, blue) {
  const redIndex = Math.min(5, Math.round((red / 255) * 5));
  const greenIndex = Math.min(6, Math.round((green / 255) * 6));
  const blueIndex = Math.min(5, Math.round((blue / 255) * 5));
  return redIndex * 42 + greenIndex * 6 + blueIndex;
}

function readFourCC(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function readUint16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint24(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readUint32(bytes, offset) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function writeAscii(bytes, offset, text) {
  for (let index = 0; index < text.length; index += 1) {
    bytes[offset + index] = text.charCodeAt(index);
  }
}

function writeUint24(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
}

function writeUint32(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
  bytes[offset + 3] = (value >> 24) & 0xff;
}

function nextFrame() {
  if (typeof requestAnimationFrame === "function") {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  return Promise.resolve();
}

class ByteStream {
  constructor() {
    this.bytes = [];
  }

  writeByte(value) {
    this.bytes.push(value & 0xff);
  }

  writeShort(value) {
    this.writeByte(value & 0xff);
    this.writeByte((value >> 8) & 0xff);
  }

  writeAscii(text) {
    for (let index = 0; index < text.length; index += 1) {
      this.writeByte(text.charCodeAt(index));
    }
  }

  writeBytes(values) {
    for (const value of values) {
      this.writeByte(value);
    }
  }

  toUint8Array() {
    return Uint8Array.from(this.bytes);
  }
}

class BitWriter {
  constructor() {
    this.bytes = [];
    this.current = 0;
    this.bitLength = 0;
  }

  write(code, size) {
    let value = code;
    let remaining = size;

    while (remaining > 0) {
      this.current |= (value & 1) << this.bitLength;
      this.bitLength += 1;
      value >>= 1;
      remaining -= 1;

      if (this.bitLength === 8) {
        this.bytes.push(this.current);
        this.current = 0;
        this.bitLength = 0;
      }
    }
  }

  finish() {
    if (this.bitLength > 0) {
      this.bytes.push(this.current);
      this.current = 0;
      this.bitLength = 0;
    }

    return Uint8Array.from(this.bytes);
  }
}
