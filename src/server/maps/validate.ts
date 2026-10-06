import { createHash } from "node:crypto";
import sharp from "sharp";
import { PipelineError } from "@/server/operations/errors";

export const MAP_LIMITS = {
  json: 2 * 1024 * 1024,
  png: 20 * 1024 * 1024,
  pixels: 200_000_000,
  axis: 24_576,
} as const;
export const sha256 = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
export const mapRevision = (json: string, png: string) =>
  `sha256:${sha256(`${json}\n${png}\n`)}`;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function detectFormat(document: unknown) {
  return object(document) && document.version === 80 && object(document.graph)
    ? { id: "rail-map-painter" as const, document_version: 80 as const }
    : null;
}

export function validateDocument(bytes: Buffer) {
  if (bytes.length > MAP_LIMITS.json)
    throw new PipelineError("file_too_large", 413);
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new PipelineError("invalid_json");
  }
  const format = detectFormat(doc);
  if (!format || !object(doc))
    throw new PipelineError("unsupported_map_format");
  if (
    typeof doc.mapEnabled !== "boolean" ||
    !object(doc.mapStyle) ||
    !finite(doc.svgViewBoxZoom) ||
    doc.svgViewBoxZoom <= 0 ||
    !object(doc.svgViewBoxMin) ||
    !finite(doc.svgViewBoxMin.x) ||
    !finite(doc.svgViewBoxMin.y) ||
    !Array.isArray(doc.images) ||
    !object(doc.graph) ||
    !Array.isArray(doc.graph.nodes) ||
    !Array.isArray(doc.graph.edges) ||
    !object(doc.graph.options) ||
    !object(doc.graph.attributes)
  )
    throw new PipelineError("invalid_map_document");
  const nodes = new Set<string>();
  const edges = new Set<string>();
  for (const node of doc.graph.nodes) {
    if (
      !object(node) ||
      typeof node.key !== "string" ||
      !node.key ||
      nodes.has(node.key) ||
      !object(node.attributes) ||
      !finite(node.attributes.x) ||
      !finite(node.attributes.y) ||
      typeof node.attributes.type !== "string"
    )
      throw new PipelineError("invalid_map_graph");
    nodes.add(node.key);
  }
  for (const edge of doc.graph.edges) {
    if (
      !object(edge) ||
      typeof edge.key !== "string" ||
      !edge.key ||
      edges.has(edge.key) ||
      typeof edge.source !== "string" ||
      typeof edge.target !== "string" ||
      !nodes.has(edge.source) ||
      !nodes.has(edge.target) ||
      !object(edge.attributes)
    )
      throw new PipelineError("invalid_map_graph");
    edges.add(edge.key);
  }
  return { format, nodes: nodes.size, edges: edges.size };
}

/** Check every chunk boundary and reject APNG; sharp then decodes all scanlines. */
export async function validatePng(bytes: Buffer) {
  if (bytes.length > MAP_LIMITS.png)
    throw new PipelineError("file_too_large", 413);
  if (
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new PipelineError("invalid_png");
  let offset = 8;
  let ended = false;
  let dataSeen = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const tag = bytes.toString("ascii", offset + 4, offset + 8);
    if (
      length > bytes.length - offset - 12 ||
      ["acTL", "fcTL", "fdAT"].includes(tag) ||
      (offset === 8 && (tag !== "IHDR" || length !== 13)) ||
      crc32(bytes.subarray(offset + 4, offset + 8 + length)) !==
        bytes.readUInt32BE(offset + 8 + length)
    )
      throw new PipelineError("invalid_png");
    if (tag === "IDAT") dataSeen = true;
    offset += length + 12;
    if (tag === "IEND") {
      ended = length === 0 && offset === bytes.length;
      break;
    }
  }
  if (!ended || !dataSeen) throw new PipelineError("invalid_png");
  try {
    const options = {
      limitInputPixels: MAP_LIMITS.pixels,
      sequentialRead: true,
      failOn: "warning" as const,
    };
    const metadata = await sharp(bytes, options).metadata();
    const { width, height } = metadata;
    if (
      metadata.format !== "png" ||
      !width ||
      !height ||
      width > MAP_LIMITS.axis ||
      height > MAP_LIMITS.axis ||
      width * height > MAP_LIMITS.pixels ||
      (metadata.pages ?? 1) > 1
    )
      throw new PipelineError("image_dimensions_exceeded");
    // Reduction forces a complete decode while avoiding a full raw output buffer.
    const overview = await sharp(bytes, options)
      .resize({
        width: 2400,
        height: 2400,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png({ compressionLevel: 9 })
      .toBuffer();
    return { width, height, overview };
  } catch (error) {
    if (error instanceof PipelineError) throw error;
    throw new PipelineError("invalid_png");
  }
}

export interface MapManifest {
  schema_version: 1;
  editor: { id: "rail-map-painter"; document_version: 80 };
  map_revision: string;
  base_map_revision: string | null;
  base_commit_sha: string | null;
  operation_id: string;
  contributor_display_name: string;
  summary: string;
  selected_issue_numbers: number[];
  created_at: string;
  files: {
    json: { path: "maps/network.json"; sha256: string; bytes: number };
    png: {
      path: "maps/network.png";
      sha256: string;
      bytes: number;
      width: number;
      height: number;
    };
  };
}

export function parseManifest(bytes: Buffer): MapManifest {
  let m: MapManifest;
  try {
    m = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new PipelineError("invalid_manifest");
  }
  const hash = /^[a-f0-9]{64}$/;
  const revision = /^sha256:[a-f0-9]{64}$/;
  if (
    !m ||
    m.schema_version !== 1 ||
    m.editor?.id !== "rail-map-painter" ||
    m.editor?.document_version !== 80 ||
    !revision.test(m.map_revision) ||
    !m.files ||
    m.files.json?.path !== "maps/network.json" ||
    m.files.png?.path !== "maps/network.png" ||
    !hash.test(m.files.json.sha256) ||
    !hash.test(m.files.png.sha256) ||
    !Number.isSafeInteger(m.files.json.bytes) ||
    m.files.json.bytes < 1 ||
    m.files.json.bytes > MAP_LIMITS.json ||
    !Number.isSafeInteger(m.files.png.bytes) ||
    m.files.png.bytes < 1 ||
    m.files.png.bytes > MAP_LIMITS.png ||
    !Number.isSafeInteger(m.files.png.width) ||
    !Number.isSafeInteger(m.files.png.height) ||
    !Array.isArray(m.selected_issue_numbers) ||
    m.selected_issue_numbers.length > 100 ||
    m.selected_issue_numbers.some((n) => !Number.isSafeInteger(n) || n < 1) ||
    typeof m.operation_id !== "string" ||
    !/^[a-zA-Z0-9-]{1,100}$/.test(m.operation_id) ||
    typeof m.contributor_display_name !== "string" ||
    typeof m.summary !== "string" ||
    typeof m.created_at !== "string" ||
    !Number.isFinite(Date.parse(m.created_at)) ||
    (m.base_map_revision !== null && !revision.test(m.base_map_revision)) ||
    (m.base_commit_sha !== null && !/^[a-f0-9]{40}$/.test(m.base_commit_sha)) ||
    (m.base_map_revision === null) !== (m.base_commit_sha === null)
  )
    throw new PipelineError("invalid_manifest");
  if (mapRevision(m.files.json.sha256, m.files.png.sha256) !== m.map_revision)
    throw new PipelineError("manifest_checksum_mismatch");
  return m;
}

export async function validatePair(
  json: Buffer,
  png: Buffer,
  manifest?: MapManifest,
) {
  const document = validateDocument(json);
  const image = await validatePng(png);
  const jsonHash = sha256(json);
  const pngHash = sha256(png);
  const revision = mapRevision(jsonHash, pngHash);
  if (
    manifest &&
    (manifest.map_revision !== revision ||
      manifest.files.json.sha256 !== jsonHash ||
      manifest.files.png.sha256 !== pngHash ||
      manifest.files.json.bytes !== json.length ||
      manifest.files.png.bytes !== png.length ||
      manifest.files.png.width !== image.width ||
      manifest.files.png.height !== image.height)
  )
    throw new PipelineError("manifest_checksum_mismatch");
  return { document, image, jsonHash, pngHash, revision };
}
