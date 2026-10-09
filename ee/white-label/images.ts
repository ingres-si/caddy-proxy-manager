// SPDX-License-Identifier: Elastic-2.0
/**
 * Uploaded logos and favicons: PNG, JPEG, WebP and ICO only, recognised by
 * their content (magic bytes), never by the file name or declared type.
 *
 * Every file is parsed structure by structure and written out again with only
 * the parts a browser needs to draw it:
 *  - nothing may follow the end of the image (PNG IEND, JPEG EOI, the RIFF
 *    size of WebP, the last ICO image), so HTML, ZIP or anything else
 *    appended to a valid image is refused;
 *  - metadata that can carry arbitrary bytes is dropped (PNG text and private
 *    chunks, JPEG comments and APPn segments other than JFIF/ICC/Adobe, WebP
 *    EXIF/XMP);
 *  - a file that contains markup or script anywhere (`<script`, `<svg`,
 *    `<!doctype`, `javascript:` and the like) is refused outright, before and
 *    after the rewrite, so polyglots that are both an image and a document
 *    never get stored.
 * SVG is never accepted: it is a document that can run script.
 *
 * Nothing here decodes pixels; the dimensions come from the headers.
 */
import { ApiValidationError } from "@/src/lib/api-errors";
import { IMAGE_TYPE_LABELS, type ImageType } from "./types";

export class ImageRejectedError extends ApiValidationError {
  constructor(message: string) {
    super(message);
    this.name = "ImageRejectedError";
  }
}

export type SanitizedImage = { type: ImageType; width: number; height: number; data: Buffer };

export type ImageRules = {
  types: readonly ImageType[];
  maxWidth: number;
  maxHeight: number;
  maxBytes: number;
};

function reject(message: string): never {
  throw new ImageRejectedError(message);
}

// ── Detection ──────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function ascii(data: Buffer, start: number, end: number): string {
  return end <= data.length ? data.toString("latin1", start, end) : "";
}

/** The image type the content says it is, or null. */
export function detectImageType(data: Buffer): ImageType | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 12) === "WEBP") return "image/webp";
  if (data.length >= 6 && data.readUInt16LE(0) === 0 && data.readUInt16LE(2) === 1 && data.readUInt16LE(4) > 0) {
    return "image/x-icon";
  }
  return null;
}

/** A text document (SVG, HTML, XML): its first character, after a BOM and white space, is "<". */
export function looksLikeMarkupDocument(data: Buffer): boolean {
  let text = data.subarray(0, 512).toString("latin1");
  if (text.startsWith("\xef\xbb\xbf")) text = text.slice(3);
  else if (text.startsWith("\xff\xfe") || text.startsWith("\xfe\xff")) text = text.slice(2).replace(/\0/g, "");
  return text.trimStart().startsWith("<");
}

/**
 * Markup or script anywhere in the bytes, case-insensitively. Each pattern is
 * at least five bytes with a delimiter, so compressed image data matches one
 * by chance with negligible probability.
 */
const EMBEDDED_MARKUP =
  /<(?:script|html|body|head|iframe|frame|object|embed|style|meta|link|form|svg|math|template|base)[\s/>]|<\?xml|<\?php|<!doctype|<!entity|<!\[cdata\[|javascript:|vbscript:|\bon(?:error|load)\s*=/i;

export function containsEmbeddedMarkup(data: Buffer): boolean {
  return EMBEDDED_MARKUP.test(data.toString("latin1"));
}

// ── PNG ────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Ancillary chunks that change how the image looks; every other ancillary chunk is dropped. */
const PNG_KEPT_ANCILLARY = new Set(["tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "cICP", "sBIT", "pHYs", "bKGD"]);

function sanitizePng(data: Buffer): SanitizedImage {
  if (data.length < 8 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) reject("The PNG image is damaged");
  const kept: Buffer[] = [PNG_SIGNATURE];
  let offset = 8;
  let width = 0;
  let height = 0;
  let sawHeader = false;
  let sawData = false;
  let dataEnded = false;
  let sawEnd = false;
  while (offset < data.length) {
    if (offset + 12 > data.length) reject("The PNG image is truncated");
    const length = data.readUInt32BE(offset);
    if (length > 0x7fffffff || offset + 12 + length > data.length) reject("The PNG image is truncated");
    const type = data.toString("latin1", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) reject("The PNG image is damaged");
    const stored = data.readUInt32BE(offset + 8 + length);
    if (crc32(data.subarray(offset + 4, offset + 8 + length)) !== stored) reject("The PNG image is damaged (checksum mismatch)");
    const chunk = data.subarray(offset, offset + 12 + length);
    offset += 12 + length;

    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) reject("The PNG image is damaged (no header)");
      const body = chunk.subarray(8, 21);
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [bitDepth, colorType, compression, filter, interlace] = body.subarray(8, 13);
      if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) reject("The PNG image has no size");
      if (![1, 2, 4, 8, 16].includes(bitDepth) || ![0, 2, 3, 4, 6].includes(colorType)) reject("The PNG image is damaged");
      if (compression !== 0 || filter !== 0 || interlace > 1) reject("The PNG image is damaged");
      sawHeader = true;
      kept.push(chunk);
      continue;
    }
    if (type === "IHDR") reject("The PNG image is damaged");
    if (type === "IEND") {
      if (length !== 0) reject("The PNG image is damaged");
      sawEnd = true;
      kept.push(chunk);
      break;
    }
    if (type === "IDAT") {
      if (dataEnded) reject("The PNG image is damaged (split image data)");
      sawData = true;
      kept.push(chunk);
      continue;
    }
    if (sawData) dataEnded = true;
    if (type === "PLTE" || PNG_KEPT_ANCILLARY.has(type)) {
      kept.push(chunk);
    } else if ((type.charCodeAt(0) & 0x20) === 0) {
      // An unknown critical chunk: a decoder must not draw the image without it.
      reject(`The PNG image uses an unsupported ${type} chunk`);
    }
    // Other ancillary chunks (text, EXIF, time, animation, private) are dropped.
  }
  if (!sawEnd) reject("The PNG image is truncated");
  if (offset !== data.length) reject("The PNG image has data after its end");
  if (!sawData) reject("The PNG image has no image data");
  return { type: "image/png", width, height, data: Buffer.concat(kept) };
}

// ── JPEG ───────────────────────────────────────────────────────────────

function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** Table and control segments a decoder needs. */
const JPEG_KEPT_SEGMENTS = new Set([0xc4, 0xcc, 0xdb, 0xdc, 0xdd, 0xde, 0xdf]);

function sanitizeJpeg(data: Buffer): SanitizedImage {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) reject("The JPEG image is damaged");
  const kept: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let offset = 2;
  let width = 0;
  let height = 0;
  let sawFrame = false;
  let sawScan = false;
  let sawEnd = false;
  while (offset < data.length) {
    if (data[offset] !== 0xff) reject("The JPEG image is damaged");
    while (offset < data.length && data[offset] === 0xff) offset++;
    if (offset >= data.length) reject("The JPEG image is truncated");
    const marker = data[offset++];
    if (marker === 0x00 || marker === 0xd8) reject("The JPEG image is damaged");
    if (marker === 0xd9) {
      sawEnd = true;
      kept.push(Buffer.from([0xff, 0xd9]));
      break;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      kept.push(Buffer.from([0xff, marker]));
      continue;
    }
    if (offset + 2 > data.length) reject("The JPEG image is truncated");
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) reject("The JPEG image is truncated");
    const segment = Buffer.concat([Buffer.from([0xff, marker]), data.subarray(offset, offset + length)]);
    const payload = data.subarray(offset + 2, offset + length);
    offset += length;

    if (isStartOfFrame(marker)) {
      if (payload.length < 6) reject("The JPEG image is damaged");
      height = payload.readUInt16BE(1);
      width = payload.readUInt16BE(3);
      if (width === 0 || height === 0) reject("The JPEG image has no size");
      sawFrame = true;
      kept.push(segment);
    } else if (marker === 0xda) {
      if (!sawFrame) reject("The JPEG image is damaged");
      sawScan = true;
      kept.push(segment);
      // Entropy-coded data runs to the next marker other than a stuffed byte or a restart marker.
      const start = offset;
      while (offset < data.length) {
        if (data[offset] === 0xff && offset + 1 < data.length) {
          const next = data[offset + 1];
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            offset += 2;
            continue;
          }
          if (next !== 0xff) break;
        }
        offset++;
      }
      if (offset >= data.length) reject("The JPEG image is truncated");
      kept.push(data.subarray(start, offset));
    } else if (JPEG_KEPT_SEGMENTS.has(marker)) {
      kept.push(segment);
    } else if (marker === 0xe0 || marker === 0xee) {
      // JFIF and Adobe segments affect how colours are decoded.
      kept.push(segment);
    } else if (marker === 0xe2 && payload.subarray(0, 12).toString("latin1") === "ICC_PROFILE\0") {
      kept.push(segment);
    } else if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
      // Other APPn (EXIF, XMP, ...) and comments are dropped.
    } else {
      reject("The JPEG image uses an unsupported segment");
    }
  }
  if (!sawEnd) reject("The JPEG image is truncated");
  if (offset !== data.length) reject("The JPEG image has data after its end");
  if (!sawScan) reject("The JPEG image has no image data");
  return { type: "image/jpeg", width, height, data: Buffer.concat(kept) };
}

// ── WebP ───────────────────────────────────────────────────────────────

const WEBP_KEPT_CHUNKS = new Set(["VP8X", "VP8 ", "VP8L", "ALPH", "ANIM", "ANMF", "ICCP"]);
const VP8X_EXIF_FLAG = 0x08;
const VP8X_XMP_FLAG = 0x04;

function sanitizeWebp(data: Buffer): SanitizedImage {
  if (data.length < 20 || ascii(data, 0, 4) !== "RIFF" || ascii(data, 8, 12) !== "WEBP") reject("The WebP image is damaged");
  if (data.readUInt32LE(4) + 8 !== data.length) reject("The WebP image has data after its end or is truncated");
  const kept: Buffer[] = [];
  let offset = 12;
  let width = 0;
  let height = 0;
  let first = true;
  let extended = false;
  let sawImage = false;
  while (offset < data.length) {
    if (offset + 8 > data.length) reject("The WebP image is truncated");
    const fourcc = ascii(data, offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const padded = size + (size & 1);
    if (offset + 8 + padded > data.length) reject("The WebP image is truncated");
    const payload = data.subarray(offset + 8, offset + 8 + size);
    if (first && fourcc !== "VP8 " && fourcc !== "VP8L" && fourcc !== "VP8X") reject("The WebP image is damaged");
    first = false;

    if (fourcc === "VP8X") {
      if (size < 10 || extended) reject("The WebP image is damaged");
      extended = true;
      width = payload.readUIntLE(4, 3) + 1;
      height = payload.readUIntLE(7, 3) + 1;
      const header = Buffer.from(data.subarray(offset, offset + 8 + padded));
      header[8] &= ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG);
      kept.push(header);
    } else if (fourcc === "VP8 ") {
      if (size < 10 || payload[3] !== 0x9d || payload[4] !== 0x01 || payload[5] !== 0x2a) reject("The WebP image is damaged");
      if (!extended) {
        width = payload.readUInt16LE(6) & 0x3fff;
        height = payload.readUInt16LE(8) & 0x3fff;
      }
      sawImage = true;
      kept.push(data.subarray(offset, offset + 8 + padded));
    } else if (fourcc === "VP8L") {
      if (size < 5 || payload[0] !== 0x2f) reject("The WebP image is damaged");
      if (!extended) {
        const bits = payload.readUInt32LE(1);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
      }
      sawImage = true;
      kept.push(data.subarray(offset, offset + 8 + padded));
    } else if (WEBP_KEPT_CHUNKS.has(fourcc)) {
      if (fourcc === "ANMF") sawImage = true;
      kept.push(data.subarray(offset, offset + 8 + padded));
    }
    // EXIF, XMP and unknown chunks are dropped.
    offset += 8 + padded;
  }
  if (!sawImage || width === 0 || height === 0) reject("The WebP image has no image data");
  const body = Buffer.concat(kept);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(body.length + 4, 4);
  header.write("WEBP", 8, "latin1");
  return { type: "image/webp", width, height, data: Buffer.concat([header, body]) };
}

// ── ICO ────────────────────────────────────────────────────────────────

const MAX_ICO_IMAGES = 32;

function sanitizeIco(data: Buffer): SanitizedImage {
  if (data.length < 6 || data.readUInt16LE(0) !== 0 || data.readUInt16LE(2) !== 1) reject("The ICO file is damaged");
  const count = data.readUInt16LE(4);
  if (count === 0 || count > MAX_ICO_IMAGES) reject(`An ICO file may hold 1 to ${MAX_ICO_IMAGES} images`);
  const directoryEnd = 6 + 16 * count;
  if (directoryEnd > data.length) reject("The ICO file is truncated");

  type Entry = { header: Buffer; offset: number; bytes: number; width: number; height: number };
  const entries: Entry[] = [];
  for (let i = 0; i < count; i++) {
    const header = data.subarray(6 + 16 * i, 6 + 16 * (i + 1));
    const bytes = header.readUInt32LE(8);
    const offset = header.readUInt32LE(12);
    if (offset < directoryEnd || bytes < 12 || offset + bytes > data.length) reject("The ICO file is damaged");
    entries.push({ header, offset, bytes, width: header[0] || 256, height: header[1] || 256 });
  }
  // The images must fill the rest of the file exactly: no gaps, overlaps or trailing data.
  const ranges = [...entries].sort((a, b) => a.offset - b.offset);
  let expected = directoryEnd;
  for (const range of ranges) {
    if (range.offset !== expected) reject("The ICO file has data outside its images");
    expected = range.offset + range.bytes;
  }
  if (expected !== data.length) reject("The ICO file has data after its end");

  const images = entries.map((entry) => {
    const image = data.subarray(entry.offset, entry.offset + entry.bytes);
    if (image.length >= 8 && image.subarray(0, 8).equals(PNG_SIGNATURE)) {
      const png = sanitizePng(image);
      if (png.width > 256 || png.height > 256) reject("An image inside the ICO file is larger than 256×256 pixels");
      return { entry, data: png.data, width: png.width, height: png.height };
    }
    // A BMP without its file header: BITMAPINFOHEADER (40) or its V4/V5 extensions.
    const headerSize = image.readUInt32LE(0);
    if (![40, 108, 124].includes(headerSize) || image.length < headerSize) reject("The ICO file holds an unsupported image");
    const dibWidth = image.readInt32LE(4);
    const dibHeight = Math.abs(image.readInt32LE(8)) / 2;
    const bitCount = image.readUInt16LE(14);
    if (dibWidth <= 0 || dibWidth > 256 || dibHeight <= 0 || dibHeight > 256 || ![1, 4, 8, 16, 24, 32].includes(bitCount)) {
      reject("The ICO file holds an unsupported image");
    }
    return { entry, data: Buffer.from(image), width: dibWidth, height: dibHeight };
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  const directory: Buffer[] = [];
  let next = directoryEnd;
  for (const image of images) {
    const entry = Buffer.from(image.entry.header);
    entry.writeUInt32LE(image.data.length, 8);
    entry.writeUInt32LE(next, 12);
    next += image.data.length;
    directory.push(entry);
  }
  return {
    type: "image/x-icon",
    width: Math.max(...images.map((image) => Math.max(image.width, image.entry.width))),
    height: Math.max(...images.map((image) => Math.max(image.height, image.entry.height))),
    data: Buffer.concat([header, ...directory, ...images.map((image) => image.data)]),
  };
}

// ── Entry points ───────────────────────────────────────────────────────

const SANITIZERS: Record<ImageType, (data: Buffer) => SanitizedImage> = {
  "image/png": sanitizePng,
  "image/jpeg": sanitizeJpeg,
  "image/webp": sanitizeWebp,
  "image/x-icon": sanitizeIco,
};

const EXTENSIONS: Record<ImageType, readonly string[]> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg", "jfif", "jpe"],
  "image/webp": ["webp"],
  "image/x-icon": ["ico"],
};

function allowedList(types: readonly ImageType[]): string {
  const labels = types.map((type) => IMAGE_TYPE_LABELS[type]);
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}` : labels[0];
}

function formatKb(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * Optional checks on what the client said about the file. The content
 * decides the type; a name or declared type that contradicts it is refused,
 * and SVG or markup types are refused whatever the content.
 */
export function checkDeclaredFile(type: ImageType, fileName: string | null, declaredType: string | null): void {
  const declared = (declaredType ?? "").toLowerCase();
  if (/svg|html|xml|javascript/.test(declared)) reject("SVG and other markup files are not accepted");
  if (!fileName) return;
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(fileName.trim());
  if (!match) return;
  const extension = match[1].toLowerCase();
  if (extension === "svg" || extension === "svgz") reject("SVG files are not accepted");
  if (!EXTENSIONS[type].includes(extension)) {
    reject(`The file name ends in .${extension} but the file is a ${IMAGE_TYPE_LABELS[type]} image`);
  }
}

/**
 * Checks an upload against `rules` and returns it rewritten without
 * metadata. Throws ImageRejectedError (400) with a message for the user.
 */
export function sanitizeImage(input: Uint8Array, rules: ImageRules): SanitizedImage {
  const data = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (data.length === 0) reject("The file is empty");
  if (data.length > rules.maxBytes) reject(`The file is larger than ${formatKb(rules.maxBytes)}`);
  const type = detectImageType(data);
  if (!type) {
    if (looksLikeMarkupDocument(data)) reject(`SVG and other markup files are not accepted; upload a ${allowedList(rules.types)} image`);
    reject(`Only ${allowedList(rules.types)} images are accepted`);
  }
  if (!rules.types.includes(type)) reject(`${IMAGE_TYPE_LABELS[type]} images are not accepted here; use ${allowedList(rules.types)}`);
  if (containsEmbeddedMarkup(data)) reject("The image contains embedded HTML or script and is not accepted");

  const image = SANITIZERS[type](data);
  if (image.width > rules.maxWidth || image.height > rules.maxHeight) {
    reject(`The image is ${image.width}×${image.height} pixels; at most ${rules.maxWidth}×${rules.maxHeight} is accepted`);
  }
  if (image.data.length > rules.maxBytes) reject(`The file is larger than ${formatKb(rules.maxBytes)}`);
  if (containsEmbeddedMarkup(image.data)) reject("The image contains embedded HTML or script and is not accepted");
  return image;
}
