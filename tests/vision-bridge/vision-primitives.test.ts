import { describe, it, expect } from 'vitest';
import {
  normalizeVisionCapabilities,
  getVisionCapabilities,
  normalizeBox,
  normalizePoint,
  normalizeVisualPrimitives,
  extractJsonObject,
  formatStructuredVisionNote,
  formatVisualPrimitives,
  rawVisualPrimitiveItems,
} from '../../src/vision-bridge/vision-primitives.js';
import type { VisionCapabilities } from '../../src/vision-bridge/vision-bridge-types.js';

// ─── Capabilities Normalization ───

function makeCaps(overrides: Partial<VisionCapabilities> = {}): VisionCapabilities {
  return {
    grounding: true,
    boxes: true,
    points: false,
    coordinateSpace: 'norm-1000',
    boxOrder: 'xyxy',
    outputFormat: 'hanako',
    groundingMode: 'native',
    ...overrides,
  };
}

describe('normalizeVisionCapabilities', () => {
  it('returns null for non-object input', () => {
    expect(normalizeVisionCapabilities(null)).toBeNull();
    expect(normalizeVisionCapabilities(undefined)).toBeNull();
    expect(normalizeVisionCapabilities('string')).toBeNull();
    expect(normalizeVisionCapabilities([])).toBeNull();
  });

  it('returns null without grounding', () => {
    expect(normalizeVisionCapabilities({ boxes: true })).toBeNull();
  });

  it('returns null for unsupported coordinate space', () => {
    expect(normalizeVisionCapabilities({ grounding: true, coordinateSpace: 'pixel-1000' })).toBeNull();
  });

  it('returns null when both boxes and points are disabled', () => {
    expect(normalizeVisionCapabilities({ grounding: true, boxes: false, points: false })).toBeNull();
  });

  it('defaults boxOrder to xyxy', () => {
    const result = normalizeVisionCapabilities({ grounding: true, boxes: true });
    expect(result?.boxOrder).toBe('xyxy');
  });

  it('accepts yxyx boxOrder', () => {
    const result = normalizeVisionCapabilities({ grounding: true, boxes: true, boxOrder: 'yxyx' });
    expect(result?.boxOrder).toBe('yxyx');
  });

  it('accepts valid output formats', () => {
    for (const fmt of ['gemini', 'qwen', 'anchor', 'hanako']) {
      const result = normalizeVisionCapabilities({ grounding: true, boxes: true, outputFormat: fmt });
      expect(result?.outputFormat).toBe(fmt);
    }
  });

  it('defaults outputFormat to hanako for unknown values', () => {
    const result = normalizeVisionCapabilities({ grounding: true, boxes: true, outputFormat: 'unknown' });
    expect(result?.outputFormat).toBe('hanako');
  });
});

describe('getVisionCapabilities', () => {
  it('returns null for non-object model', () => {
    expect(getVisionCapabilities(null)).toBeNull();
    expect(getVisionCapabilities('string')).toBeNull();
  });

  it('returns null for model without visionCapabilities', () => {
    expect(getVisionCapabilities({ id: 'test', provider: 'test' })).toBeNull();
  });

  it('extracts visionCapabilities from model', () => {
    const model = {
      id: 'gpt-4o',
      provider: 'openai',
      visionCapabilities: { grounding: true, boxes: true, outputFormat: 'anchor', groundingMode: 'prompted' },
    };
    const result = getVisionCapabilities(model);
    expect(result).not.toBeNull();
    expect(result?.outputFormat).toBe('anchor');
    expect(result?.groundingMode).toBe('prompted');
  });
});

// ─── Coordinate Normalization ───

describe('normalizeBox', () => {
  const caps = makeCaps();

  it('normalizes a standard box', () => {
    const result = normalizeBox([100, 200, 300, 400], caps);
    expect(result).toEqual([100, 200, 300, 400]);
  });

  it('returns null for zero-area box', () => {
    expect(normalizeBox([100, 200, 100, 400], caps)).toBeNull(); // left === right
    expect(normalizeBox([100, 200, 300, 200], caps)).toBeNull(); // top === bottom
  });

  it('returns null for invalid inputs', () => {
    expect(normalizeBox([], caps)).toBeNull();
    expect(normalizeBox([1, 2], caps)).toBeNull();
    expect(normalizeBox(null as any, caps)).toBeNull();
  });

  it('clamps to 0-1000 range', () => {
    const result = normalizeBox([-50, 200, 1500, 400], caps);
    expect(result).toEqual([0, 200, 1000, 400]);
  });

  it('converts yxyx to xyxy', () => {
    const yxyxCaps = makeCaps({ boxOrder: 'yxyx' });
    // input: [ymin, xmin, ymax, xmax] = [100, 200, 300, 400]
    // output: [left, top, right, bottom] = [200, 100, 400, 300]
    const result = normalizeBox([100, 200, 300, 400], yxyxCaps);
    expect(result).toEqual([200, 100, 400, 300]);
  });
});

describe('normalizePoint', () => {
  it('normalizes a standard point', () => {
    const result = normalizePoint([500, 600]);
    expect(result).toEqual([500, 600]);
  });

  it('clamps to 0-1000 range', () => {
    const result = normalizePoint([-10, 1500]);
    expect(result).toEqual([0, 1000]);
  });

  it('returns null for invalid inputs', () => {
    expect(normalizePoint([])).toBeNull();
    expect(normalizePoint([1])).toBeNull();
    expect(normalizePoint(null as any)).toBeNull();
  });
});

// ─── Batch Normalization ───

describe('normalizeVisualPrimitives', () => {
  const caps = makeCaps();

  it('returns empty for non-array inputs', () => {
    expect(normalizeVisualPrimitives(null as any, caps)).toEqual([]);
    expect(normalizeVisualPrimitives('string' as any, caps)).toEqual([]);
  });

  it('normalizes valid boxes', () => {
    const items = [
      { box: [100, 200, 300, 400], label: 'cat' },
      { box: [50, 60, 150, 160], label: 'dog' },
    ];
    const result = normalizeVisualPrimitives(items, caps);
    expect(result).toHaveLength(2);
    expect(result[0]!.type).toBe('box');
    expect(result[0]!.label).toBe('cat');
  });

  it('deduplicates by coordinate signature', () => {
    const items = [
      { box: [100, 200, 300, 400], label: 'first' },
      { box: [100, 200, 300, 400], label: 'duplicate' },
    ];
    const result = normalizeVisualPrimitives(items, caps);
    expect(result).toHaveLength(1);
    expect(result[0]!.label).toBe('first');
  });

  it('limits to 16 primitives', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      box: [i * 10, i * 10 + 5, i * 10 + 8, i * 10 + 15],
      label: `obj_${i}`,
    }));
    const result = normalizeVisualPrimitives(items, caps);
    expect(result).toHaveLength(16);
  });

  it('filters out invalid primitives', () => {
    const items = [
      { box: [100, 200, 300, 400], label: 'valid' },
      { box: null, label: 'no box' },
      { box: [1, 2], label: 'incomplete' },
    ];
    const result = normalizeVisualPrimitives(items, caps);
    expect(result).toHaveLength(1);
  });
});

// ─── JSON Extraction ───

describe('extractJsonObject', () => {
  it('parses plain JSON', () => {
    const result = extractJsonObject('{"foo": "bar", "num": 42}');
    expect(result).toEqual({ foo: 'bar', num: 42 });
  });

  it('parses fenced code block', () => {
    const result = extractJsonObject('Here is the result:\n```json\n{"foo": "bar"}\n```\nMore text.');
    expect(result).toEqual({ foo: 'bar' });
  });

  it('parses brace-delimited JSON in text', () => {
    const result = extractJsonObject('The answer is {"image_overview": "a cat"} end.');
    expect(result).toEqual({ image_overview: 'a cat' });
  });

  it('returns null for non-JSON text', () => {
    const result = extractJsonObject('This is just text, no JSON here.');
    expect(result).toBeNull();
  });

  it('returns null for JSON arrays (not objects)', () => {
    const result = extractJsonObject('[1, 2, 3]');
    expect(result).toBeNull();
  });
});

// ─── Formatting ───

describe('formatVisualPrimitives', () => {
  it('returns empty note for no primitives', () => {
    const result = formatVisualPrimitives([], 'native');
    expect(result).toContain('(none)');
  });

  it('formats box primitives', () => {
    const primitives = [
      { type: 'box' as const, id: 'obj_0', label: 'cat', coordinates: [100, 200, 300, 400] as [number, number, number, number] },
    ];
    const result = formatVisualPrimitives(primitives, 'native');
    expect(result).toContain('[obj_0] box: [100,200,300,400] "cat"');
  });

  it('formats point primitives', () => {
    const primitives = [
      { type: 'point' as const, id: 'pt_0', label: 'center', coordinates: [500, 500] as [number, number] },
    ];
    const result = formatVisualPrimitives(primitives, 'prompted');
    expect(result).toContain('[pt_0] point: [500,500] "center"');
  });
});

describe('formatStructuredVisionNote', () => {
  it('includes all expected sections', () => {
    const analysis = {
      image_overview: 'A photo of a cat.',
      visible_text: 'None',
      objects_and_layout: 'A cat sitting on a couch.',
      charts_or_data: 'None',
      relevance_to_user_request: 'The user asked about the image.',
      user_request_answer: 'It contains a cat.',
      evidence: 'Visual inspection.',
      uncertainty: 'Low.',
    };
    const caps = makeCaps();
    const result = formatStructuredVisionNote(analysis, caps);
    expect(result).toContain('Image Overview');
    expect(result).toContain('A photo of a cat.');
    expect(result).toContain('Visible Text');
    expect(result).toContain('Objects & Layout');
  });
});

// ─── Raw Primitive Extraction ───

describe('rawVisualPrimitiveItems', () => {
  it('extracts visual_primitives', () => {
    const items = rawVisualPrimitiveItems({ visual_primitives: [{ box: [1, 2, 3, 4] }] });
    expect(items).toHaveLength(1);
  });

  it('extracts visual_anchors', () => {
    const items = rawVisualPrimitiveItems({ visual_anchors: [{ center: [1, 2], box: [1, 2, 3, 4] }] });
    expect(items).toHaveLength(1);
  });

  it('returns undefined if no primitives present', () => {
    expect(rawVisualPrimitiveItems({})).toBeUndefined();
    expect(rawVisualPrimitiveItems({ image_overview: 'text' })).toBeUndefined();
  });
});
