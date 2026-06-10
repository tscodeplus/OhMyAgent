import type { VisionCapabilities, VisualPrimitive, NormalizedBox, NormalizedPoint } from './vision-bridge-types.js';
import { MAX_VISUAL_PRIMITIVES, MAX_PRIMITIVE_REF_CHARS } from './vision-bridge-types.js';

// ─── Vision Capabilities Normalization ───

export function normalizeVisionCapabilities(raw: unknown): VisionCapabilities | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const caps = raw as Record<string, unknown>;

  if (!caps.grounding && !caps.visualGrounding) return null;

  const coordinateSpace = caps.coordinateSpace ?? 'norm-1000';
  if (coordinateSpace !== 'norm-1000') return null;

  const boxOrder = caps.boxOrder === 'yxyx' ? 'yxyx' : 'xyxy';
  if (caps.boxOrder !== undefined && caps.boxOrder !== 'xyxy' && caps.boxOrder !== 'yxyx') return null;

  const boxes = caps.boxes !== false;
  const points = caps.points === true;

  if (!boxes && !points) return null;

  const validFormats = ['gemini', 'qwen', 'anchor', 'hanako'];
  const outputFormat = validFormats.includes(caps.outputFormat as string)
    ? (caps.outputFormat as VisionCapabilities['outputFormat'])
    : 'hanako';

  const groundingMode = caps.groundingMode === 'prompted' ? 'prompted' : 'native';

  return {
    grounding: true,
    boxes,
    points,
    coordinateSpace: 'norm-1000',
    boxOrder,
    outputFormat,
    groundingMode,
  };
}

export function getVisionCapabilities(model: unknown): VisionCapabilities | null {
  if (!model || typeof model !== 'object') return null;
  return normalizeVisionCapabilities((model as any).visionCapabilities);
}

// ─── Coordinate Normalization ───

function clampNorm(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1000, Math.round(value)));
}

export function normalizeBox(
  rawBox: number[],
  capabilities: VisionCapabilities,
): [number, number, number, number] | null {
  if (!Array.isArray(rawBox) || rawBox.length < 4) return null;

  const [a, b, c, d] = rawBox;

  // Convert to [left, top, right, bottom] regardless of source format
  const left = capabilities.boxOrder === 'yxyx' ? clampNorm(b) : clampNorm(a);
  const top = capabilities.boxOrder === 'yxyx' ? clampNorm(a) : clampNorm(b);
  const right = capabilities.boxOrder === 'yxyx' ? clampNorm(d) : clampNorm(c);
  const bottom = capabilities.boxOrder === 'yxyx' ? clampNorm(c) : clampNorm(d);

  if (left === null || top === null || right === null || bottom === null) return null;
  if (left >= right || top >= bottom) return null;

  return [left, top, right, bottom];
}

export function normalizePoint(rawPoint: number[]): [number, number] | null {
  if (!Array.isArray(rawPoint) || rawPoint.length < 2) return null;
  const x = clampNorm(rawPoint[0]);
  const y = clampNorm(rawPoint[1]);
  if (x === null || y === null) return null;
  return [x, y];
}

// ─── Label & ID Helpers ───

function primitiveLabel(raw: Record<string, unknown>, fallbackId: string): string {
  const label = (raw.ref ?? raw.label ?? raw.text ?? raw.name ?? raw.id ?? fallbackId);
  const str = String(label ?? fallbackId);
  return str.length > MAX_PRIMITIVE_REF_CHARS ? str.slice(0, MAX_PRIMITIVE_REF_CHARS - 1) + '…' : str;
}

function primitiveId(raw: Record<string, unknown>, index: number): string {
  const id = String(raw.id ?? raw.ref ?? `primitive_${index}`);
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function normalizeConfidence(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(1, n));
}

// ─── Individual Primitive Normalization ───

function normalizePrimitive(
  raw: unknown,
  index: number,
  capabilities: VisionCapabilities,
): VisualPrimitive | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const id = primitiveId(obj, index);
  const label = primitiveLabel(obj, id);
  const confidence = normalizeConfidence(obj.confidence);

  // Try box first
  if (capabilities.boxes) {
    let rawBox: number[] | undefined;
    if (Array.isArray(obj.box)) rawBox = obj.box as number[];
    else if (Array.isArray(obj.box_2d)) rawBox = obj.box_2d as number[];
    else if (Array.isArray(obj.bbox_2d)) rawBox = obj.bbox_2d as number[];

    if (rawBox) {
      const coords = normalizeBox(rawBox, capabilities);
      if (coords) {
        return { type: 'box', id, label, coordinates: coords, confidence } satisfies NormalizedBox;
      }
    }
  }

  // Then try point
  if (capabilities.points) {
    let rawPoint: number[] | undefined;
    if (Array.isArray(obj.point)) rawPoint = obj.point as number[];
    else if (Array.isArray(obj.point_2d)) rawPoint = obj.point_2d as number[];
    else if (Array.isArray(obj.center)) rawPoint = obj.center as number[];

    if (rawPoint) {
      const coords = normalizePoint(rawPoint);
      if (coords) {
        return { type: 'point', id, label, coordinates: coords, confidence } satisfies NormalizedPoint;
      }
    }
  }

  return null;
}

// ─── Batch Normalization ───

export function normalizeVisualPrimitives(
  items: unknown[],
  capabilities: VisionCapabilities,
): VisualPrimitive[] {
  if (!Array.isArray(items)) return [];

  const seen = new Set<string>();
  const result: VisualPrimitive[] = [];

  for (let i = 0; i < items.length && result.length < MAX_VISUAL_PRIMITIVES; i++) {
    const primitive = normalizePrimitive(items[i], i, capabilities);
    if (!primitive) continue;

    // Deduplicate by coordinate signature
    const sig = `${primitive.type}:${primitive.coordinates.join(',')}`;
    if (seen.has(sig)) continue;
    seen.add(sig);

    result.push(primitive);
  }

  return result;
}

// ─── Extract Primitives from Analysis JSON ───

export function rawVisualPrimitiveItems(analysis: Record<string, unknown>): unknown[] | undefined {
  const candidates = [
    analysis.visual_primitives,
    analysis.visualPrimitives,
    analysis.visual_anchors,
    analysis.visualAnchors,
    analysis.anchors,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return undefined;
}

// ─── JSON Extraction from LLM Response ───

export function extractJsonObject(text: string): Record<string, unknown> | null {
  // Try direct parse
  try {
    const result = JSON.parse(text);
    if (result && typeof result === 'object' && !Array.isArray(result)) return result;
  } catch { /* continue */ }

  // Try fenced code block
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const result = JSON.parse(fenceMatch[1].trim());
      if (result && typeof result === 'object' && !Array.isArray(result)) return result;
    } catch { /* continue */ }
  }

  // Try first {…} block
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      const result = JSON.parse(braceMatch[0]);
      if (result && typeof result === 'object' && !Array.isArray(result)) return result;
    } catch { /* continue */ }
  }

  return null;
}

// ─── Formatting ───

import {
  VISUAL_PRIMITIVES_START,
  VISUAL_PRIMITIVES_END,
  VISION_CONTEXT_START,
  VISION_CONTEXT_END,
} from './vision-bridge-types.js';
import { formatSectionNamePublic } from './vision-bridge-prompts.js';

export function formatVisualPrimitives(
  primitives: VisualPrimitive[],
  groundingMode: string,
): string {
  if (primitives.length === 0) {
    return `${VISUAL_PRIMITIVES_START}\n(none)\n${VISUAL_PRIMITIVES_END}`;
  }

  const lines: string[] = [VISUAL_PRIMITIVES_START];

  if (groundingMode === 'native') {
    lines.push(`The analysis model detected and grounded ${primitives.length} visual element(s).`);
    lines.push('Refer to elements by their id when discussing specific parts of the image.');
    lines.push('');
  }

  for (const p of primitives) {
    const conf = p.confidence !== undefined ? ` conf=${p.confidence.toFixed(2)}` : '';
    if (p.type === 'box') {
      const [l, t, r, b] = p.coordinates;
      lines.push(`  [${p.id}] box: [${l},${t},${r},${b}] "${p.label ?? ''}"${conf}`);
    } else {
      const [x, y] = p.coordinates;
      lines.push(`  [${p.id}] point: [${x},${y}] "${p.label ?? ''}"${conf}`);
    }
  }

  lines.push(VISUAL_PRIMITIVES_END);
  return lines.join('\n');
}

export function formatStructuredVisionNote(
  analysis: Record<string, unknown>,
  capabilities: VisionCapabilities,
): string {
  const sections = [
    'image_overview',
    'visible_text',
    'objects_and_layout',
    'charts_or_data',
    'relevance_to_user_request',
    'user_request_answer',
    'evidence',
    'uncertainty',
  ];

  const lines: string[] = [VISION_CONTEXT_START, '## Image Analysis', ''];

  for (const key of sections) {
    const title = formatSectionNamePublic(key);
    const value = typeof analysis[key] === 'string' ? (analysis[key] as string).trim() : '';
    lines.push(`### ${title}`);
    lines.push(value || '(not provided)');
    lines.push('');
  }

  // Append visual primitives
  const rawPrimitives = rawVisualPrimitiveItems(analysis);
  const primitives = rawPrimitives
    ? normalizeVisualPrimitives(rawPrimitives, capabilities)
    : [];
  lines.push(formatVisualPrimitives(primitives, capabilities.groundingMode));
  lines.push('');
  lines.push(VISION_CONTEXT_END);

  return lines.join('\n');
}

export function formatInvalidStructuredNote(rawResponse: string): string {
  const excerpt = rawResponse.slice(0, 500).trim();
  return [
    VISION_CONTEXT_START,
    '## Image Analysis',
    '',
    '### Note',
    'The vision model returned a response that could not be parsed as structured analysis.',
    '',
    '### Raw Excerpt',
    excerpt || '(empty response)',
    '',
    VISION_CONTEXT_END,
  ].join('\n');
}

export function formatSimpleVisionNote(text: string): string {
  const trimmed = text.trim();
  return [
    VISION_CONTEXT_START,
    '## Image Analysis',
    '',
    trimmed || '(no analysis returned)',
    '',
    VISION_CONTEXT_END,
  ].join('\n');
}
