import { describe, it, expect } from 'vitest';
import type { GraphEdge, GraphNode } from '../../ui/src/types/graph';
import {
  MAX_RENDERED,
  NODE_RADIUS,
  layoutGraph,
  type LayoutResult,
} from '../../ui/src/components/graph/layout';

/**
 * The drawing is the only view of the graph an operator gets, so the properties
 * asserted here are the ones a wrong layout breaks silently: two clusters drawn
 * on top of each other, a cap that cuts a chain in half, a node the user opened
 * missing from the canvas, or a picture that moves between renders.
 *
 * Sizes are CSS pixels because the panel's `viewBox` is the measured box — one
 * unit is one pixel — which is what stopped the same graph rendering 9px labels
 * at 7px on a phone and 18px on a wide desktop.
 */

function node(id: string, degree = 1): GraphNode {
  return { id, name: id, canonical_name: id.toLowerCase(), entity_type: 'concept', degree };
}

function edge(source: string, target: string): GraphEdge {
  return { id: `${source}->${target}`, source, target, relation_type: 'USES', confidence: 0.9 };
}

function layout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  extra: Partial<Parameters<typeof layoutGraph>[0]> = {},
): LayoutResult {
  return layoutGraph({ nodes, edges, width: 640, maxHeight: 480, ...extra });
}

function bboxOf(result: LayoutResult, ids: string[]) {
  const points = ids.map((id) => result.points.get(id)).filter(Boolean) as Array<{
    x: number;
    y: number;
  }>;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

describe('graph layout', () => {
  it('lists names without a relation instead of drawing them as dots', () => {
    const result = layout(
      [node('api', 3), node('python'), node('excel'), node('ubuntu'), node('termux')],
      [edge('python', 'api'), edge('termux', 'api')],
      { focusId: 'api' },
    );

    expect(result.rendered.map((entry) => entry.id).sort()).toEqual(['api', 'python', 'termux']);
    expect(result.points.size).toBe(3);
    // Sorted by degree then name, so the chip list starts with the busiest name.
    expect(result.unlinked.map((entry) => entry.id)).toEqual(['excel', 'ubuntu']);
  });

  it('keeps two clusters apart instead of letting them merge', () => {
    const nodes = ['a1', 'a2', 'a3', 'b1', 'b2'].map((id) => node(id));
    const edges = [edge('a1', 'a2'), edge('a2', 'a3'), edge('b1', 'b2')];
    const result = layout(nodes, edges);

    const left = bboxOf(result, ['a1', 'a2', 'a3']);
    const right = bboxOf(result, ['b1', 'b2']);
    const horizontallyApart = left.maxX < right.minX || right.maxX < left.minX;
    const verticallyApart = left.maxY < right.minY || right.maxY < left.minY;
    expect(horizontallyApart || verticallyApart).toBe(true);
  });

  it('never draws two circles on top of each other', () => {
    const nodes = ['hub', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8'].map((id) => node(id));
    const edges = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8'].map((leaf) => edge('hub', leaf));
    const result = layout(nodes, edges, { focusId: 'hub' });

    const points = [...result.points.values()];
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const distance = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
        expect(distance).toBeGreaterThanOrEqual(NODE_RADIUS * 2);
      }
    }
  });

  it('draws the opened entity even when nothing connects it', () => {
    const result = layout([node('lonely', 0), node('other')], [edge('other', 'other2')], {
      focusId: 'lonely',
    });

    expect(result.points.has('lonely')).toBe(true);
    expect(result.unlinked.map((entry) => entry.id)).not.toContain('lonely');
  });

  it('cuts between clusters, never through one', () => {
    // Ten chains of two: a per-node cap would keep five whole chains plus half of
    // the sixth, which renders as a cluster with a dangling node.
    const nodes = Array.from({ length: 20 }, (_unused, index) =>
      node(`n${String(index).padStart(2, '0')}`),
    );
    const edges = Array.from({ length: 10 }, (_unused, index) =>
      edge(`n${String(index * 2).padStart(2, '0')}`, `n${String(index * 2 + 1).padStart(2, '0')}`),
    );
    const result = layout(nodes, edges, { maxNodes: 5 });

    expect(result.points.size).toBe(4);
    expect(result.hiddenCount).toBe(16);
  });

  it('fits the height budget and never exceeds the panel width', () => {
    const nodes = Array.from({ length: 30 }, (_unused, index) => node(`n${index}`));
    const edges = Array.from({ length: 29 }, (_unused, index) =>
      edge(`n${index}`, `n${index + 1}`),
    );
    const result = layout(nodes, edges, { width: 320, maxHeight: 240 });

    expect(result.height).toBeLessThanOrEqual(241);
    for (const point of result.points.values()) {
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(320);
    }
  });

  it('is deterministic for the same input', () => {
    const nodes = ['api', 'python', 'excel', 'termux', 'obsidian'].map((id) => node(id));
    const edges = [
      edge('python', 'api'),
      edge('termux', 'api'),
      edge('excel', 'api'),
      edge('obsidian', 'termux'),
    ];
    const first = layout(nodes, edges, { focusId: 'api' });
    const second = layout(nodes, edges, { focusId: 'api' });

    expect([...second.points.entries()]).toEqual([...first.points.entries()]);
  });

  it('lays a chain out as a line outward from the root', () => {
    const nodes = ['a', 'b', 'c', 'd'].map((id) => node(id));
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')];
    const result = layout(nodes, edges, { focusId: 'a' });

    const root = result.points.get('a') as { x: number; y: number };
    const distances = ['b', 'c', 'd'].map((id) => {
      const point = result.points.get(id) as { x: number; y: number };
      return Math.hypot(point.x - root.x, point.y - root.y);
    });
    expect(distances[0]).toBeLessThan(distances[1]);
    expect(distances[1]).toBeLessThan(distances[2]);
  });

  it('gives a vertical pair the column width, not the 54px ring step', () => {
    const nodes = [node('voxcpm2.com'), node('phone-use skill')];
    const result = layout(nodes, [edge('voxcpm2.com', 'phone-use skill')], { width: 390 });

    expect(result.labels.get('voxcpm2.com')).toBe('voxcpm2.com');
    expect(result.labels.get('phone-use skill')).toBe('phone-use skill');
  });

  it('cuts a label only when its own band is crowded', () => {
    const names = [
      'shell-based monitoring',
      'power query',
      'excel-mcp',
      'termux',
      'obsidian',
      'python',
    ];
    const nodes = [node('hub', 6), ...names.map((name) => node(name))];
    const edges = names.map((name) => edge('hub', name));

    const narrow = layoutGraph({ nodes, edges, width: 240, maxHeight: 620, focusId: 'hub' });
    const wide = layoutGraph({ nodes, edges, width: 700, maxHeight: 620, focusId: 'hub' });

    // The long name loses characters on a phone and fits whole on a wide panel;
    // the short ones fit in both, which is what a global character count cannot do.
    expect(narrow.labels.get('shell-based monitoring')).toMatch(/…$/);
    expect(wide.labels.get('shell-based monitoring')).toBe('shell-based monitoring');
    expect(wide.labels.get('power query')).toBe('power query');
    expect(narrow.labels.get('excel-mcp')).toBe('excel-mcp');
  });

  it('caps the overview at the rendering limit', () => {
    const nodes = Array.from({ length: MAX_RENDERED + 20 }, (_unused, index) => node(`n${index}`));
    const edges = Array.from({ length: MAX_RENDERED + 19 }, (_unused, index) =>
      edge(`n${index}`, `n${index + 1}`),
    );
    const result = layout(nodes, edges);

    expect(result.points.size).toBeLessThanOrEqual(MAX_RENDERED);
    expect(result.hiddenCount).toBeGreaterThan(0);
  });
});
