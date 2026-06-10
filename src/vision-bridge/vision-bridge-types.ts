import type { ImageContent, Model } from '../pi-mono/ai/types.js';

// ─── Config ───

export interface VisionBridgeConfig {
  enabled: boolean;
  modelRef?: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs: number;
  maxNoteChars: number;
  maxCacheEntries: number;
}

// ─── Resolved Vision Model ───

export interface ResolvedVisionModel {
  model: Model<any>;
  apiKey: string;
  baseUrl: string;
}

// ─── Vision Capabilities (aligned with OpenHanako) ───

export interface VisionCapabilities {
  grounding: boolean;
  boxes: boolean;
  points: boolean;
  coordinateSpace: 'norm-1000';
  boxOrder: 'xyxy' | 'yxyx';
  outputFormat: 'hanako' | 'gemini' | 'qwen' | 'anchor';
  groundingMode: 'native' | 'prompted';
}

// ─── Visual Primitives ───

export interface NormalizedBox {
  type: 'box';
  id: string;
  label?: string;
  /** [left, top, right, bottom] in 0-1000 coordinate space */
  coordinates: [number, number, number, number];
  confidence?: number;
}

export interface NormalizedPoint {
  type: 'point';
  id: string;
  label?: string;
  /** [x, y] in 0-1000 coordinate space */
  coordinates: [number, number];
  confidence?: number;
}

export type VisualPrimitive = NormalizedBox | NormalizedPoint;

// ─── Vision Analysis Result ───

export interface VisionAnalysisResult {
  overview: string;
  visibleText: string;
  objectsLayout: string;
  chartsData: string;
  relevanceToRequest: string;
  requestAnswer: string;
  evidence: string;
  uncertainty: string;
  primitives?: VisualPrimitive[];
}

// ─── Cache ───

export interface CachedAnalysis {
  note: string;
  createdAt: number;
  lastUsedAt: number;
  index: number;
}

// ─── Constants ───

export const VISION_CONTEXT_START = '<VISION_CONTEXT>';
export const VISION_CONTEXT_END = '</VISION_CONTEXT>';
export const VISUAL_PRIMITIVES_START = '<VISUAL_PRIMITIVES>';
export const VISUAL_PRIMITIVES_END = '</VISUAL_PRIMITIVES>';

export const MAX_VISUAL_PRIMITIVES = 16;
export const MAX_PRIMITIVE_REF_CHARS = 96;

export const NON_VISION_IMAGE_PLACEHOLDER = '(image omitted: model does not support images)';
export const VISION_BRIDGE_FAILED_PLACEHOLDER = '(image omitted: vision bridge analysis failed)';
