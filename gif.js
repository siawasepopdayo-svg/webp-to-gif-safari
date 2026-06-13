const palette = buildPalette();

export async function rgbaToGifBlob({ data, width, height }, onProgress = () => {}) {
  const gifBytes = await rgbaToGifBytes({ data, width, height }, onProgress);
  return new Blob([gifBytes], { type: "image/gif" });
}

export async function rgbaToGifBytes({ data, width, height }, onProgress = () => {}) {
  const indexedPixels = await quantizePixels({ data, width, height }, (progress) => {
    onProgress(0.18 + progress * 0.46, "色を整理しています");
  });

  onProgress(0.7, "GIF を組み立てています");
  const gifBytes = await encodeSingleFrameGif(width, height, indexedPixels, (progress) => {
    onProgress(0.7 + progress * 0.28, "圧縮しています");
  });
  onProgress(1, "完成しました");
  return gifBytes;
}

async function quantizePixels(imageData, onProgress) {
  const { data, width, height } = imageData;
  const indexed = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelOffset = (y * width + x) * 4;
      const alpha = data[pixelOffset + 3];
      indexed[y * width + x] = alpha < 16 ? 255 : mapToPaletteIndex(
        data[pixelOffset],
        data[pixelOffset + 1],
        data[pixelOffset + 2]
      );
    }

    if (y % 12 === 0 || y === height - 1) {
      onProgress((y + 1) / height);
      await nextFrame();
    }
  }

  return indexed;
}

async function encodeSingleFrameGif(width, height, indexedPixels, onProgress) {
  const stream = new ByteStream();
  stream.writeAscii("GIF89a");
  stream.writeShort(width);
  stream.writeShort(height);
  stream.writeByte(0xf7);
  stream.writeByte(0x00);
  stream.writeByte(0x00);

  for (const [r, g, b] of palette) {
    stream.writeByte(r);
    stream.writeByte(g);
    stream.writeByte(b);
  }

  stream.writeBytes([0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0xff, 0x00]);
  stream.writeByte(0x2c);
  stream.writeShort(0);
  stream.writeShort(0);
  stream.writeShort(width);
  stream.writeShort(height);
  stream.writeByte(0x00);

  const imageData = lzwEncode(indexedPixels, 8, onProgress);
  await nextFrame();
  stream.writeByte(8);
  let offset = 0;
  while (offset < imageData.length) {
    const chunkLength = Math.min(255, imageData.length - offset);
    stream.writeByte(chunkLength);
    stream.writeBytes(imageData.subarray(offset, offset + chunkLength));
    offset += chunkLength;
  }
  stream.writeByte(0x00);
  stream.writeByte(0x3b);
  return stream.toUint8Array();
}

function lzwEncode(indices, minCodeSize, onProgress) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let nextCode = endCode + 1;
  let codeSize = minCodeSize + 1;

  const output = new BitWriter();
  output.write(clearCode, codeSize);

  let dictionary = createInitialDictionary(clearCode);
  let phrase = `${indices[0]}`;

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

function createInitialDictionary(clearCode) {
  const dictionary = new Map();
  for (let code = 0; code < clearCode; code += 1) {
    dictionary.set(`${code}`, code);
  }
  return dictionary;
}

function buildPalette() {
  const colors = [];
  for (let r = 0; r < 6; r += 1) {
    for (let g = 0; g < 7; g += 1) {
      for (let b = 0; b < 6; b += 1) {
        colors.push([
          Math.round((r / 5) * 255),
          Math.round((g / 6) * 255),
          Math.round((b / 5) * 255)
        ]);
      }
    }
  }

  while (colors.length < 255) {
    colors.push([0, 0, 0]);
  }

  colors.push([0, 0, 0]);
  return colors;
}

function mapToPaletteIndex(r, g, b) {
  const red = Math.min(5, Math.round((r / 255) * 5));
  const green = Math.min(6, Math.round((g / 255) * 6));
  const blue = Math.min(5, Math.round((b / 255) * 5));
  return red * 42 + green * 6 + blue;
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
    for (let i = 0; i < text.length; i += 1) {
      this.writeByte(text.charCodeAt(i));
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
