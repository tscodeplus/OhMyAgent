import type { GraphEdge, GraphNode } from '../../types/graph';

/**
 * Graph layout, in CSS pixels.
 *
 * Every number here is a pixel, because the drawing's `viewBox` is the measured
 * panel: one SVG unit is one CSS pixel on every screen. The previous version
 * laid out into a fixed 600×600 box and stretched it with `w-full`, so the same
 * `fontSize` rendered at ~7px on a phone and ~18px on a wide desktop — the text
 * and the circles were whatever the container made of them.
 *
 * Three steps, on purpose:
 *
 * 1. `radialComponent` shapes one connected cluster on its own: the root in the
 *    middle, each BFS layer on a ring wide enough that its labels do not touch.
 *    A knowledge graph is a handful of small trees around hubs; one global force
 *    relaxation cannot give two clusters separate space, which is how A—B—C and
 *    D—E ended up in one unreadable blob.
 * 2. `packComponents` shelves the cluster boxes side by side. Packing is
 *    arithmetic, not a simulation: the gap between two clusters is a constant,
 *    so the same data always draws the same picture and no force can pull two
 *    clusters into each other.
 * 3. `fit` grows a small drawing to use the panel and, when the drawing is too
 *    big, lowers the node budget rather than shrinking below 1:1. Scaling below
 *    1:1 while glyph sizes stay fixed is what makes labels collide — the arc
 *    per node shrinks, the text does not (the cap comment explains why whole
 *    components are preferred over per-node cuts).
 *
 * Nodes with no edge are not drawn at all: a mention is not a statement, so
 * there is no relation to look at. The caller lists them as names instead
 * (`LayoutResult.unlinked`), which is what keeps a 378-entity graph readable.
 */

/** Circle radius; small on purpose — the label carries the identity. */
export const NODE_RADIUS = 4.5;
/** The entity the user opened, drawn a touch heavier than its neighbours. */
export const FOCUS_RADIUS = 6;
export const LABEL_SIZE = 10;
/**
 * Only a safety net for absurd names: the real limit is the space a node gets
 * (`fitLabel`), so "Power Query" renders whole when the ring is wide enough and
 * is cut to "Power Qu…" only when it is not.
 */
export const LABEL_HARD_MAX_CHARS = 32;
/**
 * Rendering cap. A whole component is drawn or not drawn, so a chain never
 * arrives as two disconnected-looking halves; only the cluster the user opened
 * is cut, and only after the height budget says it cannot fit.
 */
export const MAX_RENDERED = 40;

/** Distance between two rings of the radial layout. */
const RING_STEP = 54;
/** Smallest arc between two nodes, whatever their labels say (circle + air). */
const MIN_ARC = 26;
/** Space kept between two neighbouring labels on the same ring. */
const LABEL_GAP = 6;
/**
 * Gap between two packed components across the canvas. Wide enough that a name in
 * one column does not have to stop at the next: the columns share the canvas, not
 * the edge.
 */
const COMPONENT_GAP_X = 46;
/**
 * Gap between two packed rows, which is a much smaller number for the same visual
 * distance: a box already carries `PAD_TOP` above its topmost node and
 * `PAD_BOTTOM` below its lowest label, so a row gap of 46 opened ~76px of empty
 * band between one row's labels and the next row's nodes — the drawing read as
 * sparse while the caption underneath it had 4px.
 */
const COMPONENT_GAP_Y = 18;
/**
 * A component reserves its own label half-widths (`Box.padX`), so a packed column
 * keeps room for what it prints instead of a fixed 26px guess: with a 10px font a
 * name like `memory-recall` is 76px wide, and the previous fixed padding cut it on
 * the column nearest the panel edge while the column itself had space.
 */
const MIN_PAD_X = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 18;
/**
 * Small graphs are drawn larger rather than centred in dead space: positions
 * spread, glyph sizes stay put, so a 4-node neighbourhood fills the panel
 * without its labels growing.
 */
const MAX_UPSCALE = 2;
/** Below this the drawing stops being legible; the budget shrinks instead. */
const MIN_SCALE = 0.9;
/** Never shrink the node budget below this — a picture of nothing is not a view. */
const MIN_BUDGET = 6;
/** Each retry drops the budget by this share, so the loop is short and stable. */
const BUDGET_STEP = 0.8;

export interface LayoutPoint {
  x: number;
  y: number;
}

export interface LayoutInput {
  nodes: GraphNode[];
  edges: GraphEdge[];
  focusId?: string;
  /** Measured panel width in CSS pixels. */
  width: number;
  /** Height budget in CSS pixels; the node budget shrinks to fit it. */
  maxHeight: number;
  maxNodes?: number;
}

export interface LayoutResult {
  /** Positions of every drawn node, in panel pixels. */
  points: Map<string, LayoutPoint>;
  /** Nodes drawn in the canvas, in drawing order. */
  rendered: GraphNode[];
  /** Names with no relation: listed, never drawn. */
  unlinked: GraphNode[];
  /** Nodes the cap or the height budget left out. */
  hiddenCount: number;
  /**
   * Label text per drawn node. Computed after the scale is known, so a name is
   * cut only when the space it actually got cannot hold it: the same graph shows
   * "Power Query" whole on a desktop panel and "Power Qu…" on a phone.
   */
  labels: Map<string, string>;
  width: number;
  height: number;
}

interface Box {
  ids: string[];
  positions: Map<string, LayoutPoint>;
  width: number;
  height: number;
  /** Half the widest label on this cluster, reserved on each side. */
  padX: number;
  /** Distance from the topmost/bottom mode centre to the box edge. */
  padTop: number;
  padBottom: number;
  originX: number;
  originY: number;
}

/**
 * Advance width of one character at `LABEL_SIZE`.
 *
 * A canvas has no text metrics before it draws, and measuring with an off-DOM
 * canvas on every layout would re-run on each resize. An estimate is enough
 * here because its only job is deciding between "fits" and "cut", and both
 * answers survive being a pixel or two off: CJK glyphs are square, Latin ones
 * about half as wide.
 */
function charWidth(char: string): number {
  return /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(
    char,
  )
    ? LABEL_SIZE
    : LABEL_SIZE * 0.55;
}

export function estimateLabelWidth(name: string): number {
  let width = 0;
  for (const char of name) width += charWidth(char);
  // A little slack for hinting and the halo stroke the label is drawn with.
  return Math.ceil(width * 1.06);
}

/**
 * The label a node can show in `room` pixels.
 *
 * Truncation is a last resort, not a rule: a name is cut only when the space the
 * node actually got cannot hold it. `room` comes from the drawing's own
 * geometry, so the same entity reads "Power Query" in a wide panel and "Power
 * Qu…" on a phone.
 */
export function fitLabel(name: string, room: number): string {
  if (!(room > 0)) return '';
  if (estimateLabelWidth(name) <= room) return name.slice(0, LABEL_HARD_MAX_CHARS);
  const ellipsis = '…';
  const budget = room - estimateLabelWidth(ellipsis);
  if (budget <= 0) return '';
  let used = 0;
  let text = '';
  for (const char of name) {
    const width = charWidth(char);
    if (used + width > budget) break;
    text += char;
    used += width;
    if (text.length >= LABEL_HARD_MAX_CHARS) break;
  }
  return text.length > 0 ? `${text}${ellipsis}` : '';
}

/** Union-find over the visible edges: one group per connected cluster. */
function findComponents(ids: string[], edges: GraphEdge[]): string[][] {
  const parent = new Map<string, string>(ids.map((id) => [id, id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let cursor = id;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor) as string;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  for (const edge of edges) {
    if (!parent.has(edge.source) || !parent.has(edge.target)) continue;
    const left = find(edge.source);
    const right = find(edge.target);
    if (left !== right) parent.set(left, right);
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const root = find(id);
    const group = groups.get(root);
    if (group) group.push(id);
    else groups.set(root, [id]);
  }
  return [...groups.values()];
}

/** Neighbour lists restricted to one component, in deterministic order. */
function adjacencyOf(ids: string[], edges: GraphEdge[], names: Map<string, string>) {
  const adjacency = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of edges) {
    const from = adjacency.get(edge.source);
    const to = adjacency.get(edge.target);
    if (!from || !to) continue;
    from.push(edge.target);
    to.push(edge.source);
  }
  const byName = (left: string, right: string): number =>
    (names.get(left) ?? left).localeCompare(names.get(right) ?? right);
  for (const list of adjacency.values()) list.sort(byName);
  return adjacency;
}

/** The busiest node of a cluster, or the one the user opened when it is there. */
function chooseRoot(
  ids: string[],
  focusId: string | undefined,
  degrees: Map<string, number>,
  names: Map<string, string>,
): string {
  if (focusId && ids.includes(focusId)) return focusId;
  return [...ids].sort(
    (left, right) =>
      (degrees.get(right) ?? 0) - (degrees.get(left) ?? 0) ||
      (names.get(left) ?? left).localeCompare(names.get(right) ?? right),
  )[0];
}

/**
 * Breadth-first order from the root.
 *
 * This is the order the cap slices in: keeping a prefix leaves a cluster that is
 * still connected and still centred on the root, where keeping an arbitrary
 * subset would draw a node with its edges cut off.
 */
function breadthFirst(
  ids: string[],
  edges: GraphEdge[],
  root: string,
  names: Map<string, string>,
): Array<{ id: string; parent?: string; depth: number }> {
  const adjacency = adjacencyOf(ids, edges, names);
  const visited = new Map<string, number>([[root, 0]]);
  const parentOf = new Map<string, string>();
  const order: Array<{ id: string; parent?: string; depth: number }> = [{ id: root, depth: 0 }];
  for (let cursor = 0; cursor < order.length; cursor++) {
    const { id, depth } = order[cursor];
    for (const next of adjacency.get(id) ?? []) {
      if (visited.has(next)) continue;
      visited.set(next, depth + 1);
      parentOf.set(next, id);
      order.push({ id: next, parent: id, depth: depth + 1 });
    }
  }
  // Unreachable ids cannot occur inside one component; placing them on ring 1
  // beats dropping a node the caller asked to draw.
  for (const id of ids) {
    if (!visited.has(id)) order.push({ id, parent: root, depth: 1 });
  }
  return order;
}

/**
 * Lay one cluster out around its root: BFS layers on rings.
 *
 * A ring's radius is the larger of "one step out from the previous ring" and
 * "wide enough that its nodes' labels do not touch", so a star with eight
 * leaves grows a wide ring instead of stacking labels, and a chain stays a
 * straight radial line. Nodes within a layer are ordered by their parent's
 * angle, which keeps a subtree together and stops edges crossing the middle.
 */
function radialComponent(
  order: Array<{ id: string; parent?: string; depth: number }>,
  names: Map<string, string>,
): Box {
  const ids = order.map((entry) => entry.id);
  const maxDepth = Math.max(...order.map((entry) => entry.depth), 0);
  const byDepth: Array<Array<{ id: string; parent?: string; depth: number }>> = Array.from(
    { length: maxDepth + 1 },
    () => [],
  );
  for (const entry of order) byDepth[entry.depth].push(entry);

  // Ring radius: room for this ring's labels, and never inside the last ring.
  const radius: number[] = [0];
  for (let level = 1; level <= maxDepth; level++) {
    const ring = byDepth[level];
    const labelArc = ring.reduce(
      (total, entry) => total + estimateLabelWidth(names.get(entry.id) ?? entry.id) + LABEL_GAP,
      0,
    );
    radius[level] = Math.max(
      radius[level - 1] + RING_STEP,
      labelArc / (Math.PI * 2),
      (ring.length * MIN_ARC) / (Math.PI * 2),
    );
  }

  const angle = new Map<string, number>();
  if (order.length > 0) angle.set(order[0].id, -Math.PI / 2);
  for (let level = 1; level <= maxDepth; level++) {
    const ring = byDepth[level];
    if (ring.length === 1) {
      // One node on the ring sits directly outside its parent: a chain reads as
      // a straight line instead of spiralling.
      const parentAngle = ring[0].parent ? angle.get(ring[0].parent) : undefined;
      angle.set(ring[0].id, parentAngle ?? -Math.PI / 2);
      continue;
    }
    // Order by the parent's angle so siblings of one subtree stay adjacent.
    const parentAngle = (entry: { parent?: string }): number =>
      entry.parent ? (angle.get(entry.parent) ?? 0) : 0;
    const sorted = [...ring].sort(
      (left, right) =>
        parentAngle(left) - parentAngle(right) ||
        (names.get(left.id) ?? left.id).localeCompare(names.get(right.id) ?? right.id),
    );
    const step = (Math.PI * 2) / sorted.length;
    sorted.forEach((entry, index) => angle.set(entry.id, -Math.PI / 2 + step * index));
  }

  const positions = new Map<string, LayoutPoint>();
  for (const entry of order) {
    const theta = angle.get(entry.id) ?? -Math.PI / 2;
    positions.set(entry.id, {
      x: Math.cos(theta) * radius[entry.depth],
      y: Math.sin(theta) * radius[entry.depth],
    });
  }

  const xs = [...positions.values()].map((point) => point.x);
  const ys = [...positions.values()].map((point) => point.y);
  const originX = Math.min(...xs);
  const originY = Math.min(...ys);
  const padX = Math.max(
    MIN_PAD_X,
    ...ids.map((id) => estimateLabelWidth(names.get(id) ?? id) / 2 + 2),
  );
  return {
    ids,
    positions,
    padX,
    padTop: PAD_TOP,
    padBottom: PAD_BOTTOM,
    originX,
    originY,
    width: Math.max(...xs) - originX + padX * 2,
    height: Math.max(...ys) - originY + PAD_TOP + PAD_BOTTOM,
  };
}

/**
 * Shelf-pack the component boxes: largest first, a row at a time.
 *
 * Largest first keeps a big cluster in one row instead of leaving it a slot at
 * the end of the previous one, and the fixed gap is why two clusters can never
 * be drawn on top of each other.
 */
function packComponents(
  boxes: Box[],
  available: number,
): { points: Map<string, LayoutPoint>; width: number; height: number } {
  const ordered = [...boxes].sort(
    (left, right) => right.width * right.height - left.width * left.height,
  );
  const points = new Map<string, LayoutPoint>();
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  let usedWidth = 0;
  for (const box of ordered) {
    if (cursorX > 0 && cursorX + box.width > available) {
      cursorX = 0;
      cursorY += rowHeight + COMPONENT_GAP_Y;
      rowHeight = 0;
    }
    const shiftX = cursorX + box.padX - box.originX;
    const shiftY = cursorY + box.padTop - box.originY;
    for (const [id, point] of box.positions) {
      points.set(id, { x: point.x + shiftX, y: point.y + shiftY });
    }
    cursorX += box.width + COMPONENT_GAP_X;
    usedWidth = Math.max(usedWidth, cursorX - COMPONENT_GAP_X);
    rowHeight = Math.max(rowHeight, box.height);
  }
  return { points, width: usedWidth, height: cursorY + rowHeight };
}

export function layoutGraph(input: LayoutInput): LayoutResult {
  const { nodes, edges, focusId, width, maxHeight } = input;
  const cap = Math.max(1, input.maxNodes ?? MAX_RENDERED);
  const names = new Map(nodes.map((node) => [node.id, node.name]));
  const degrees = new Map(nodes.map((node) => [node.id, node.degree]));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const visible = edges.filter((edge) => nodeById.has(edge.source) && nodeById.has(edge.target));
  const components = findComponents(
    nodes.map((node) => node.id),
    visible,
  );

  // The node the user opened is drawn even when nothing connects it: the chip
  // list is for the names they did not come to look at.
  const componentOfFocus = focusId ? components.find((ids) => ids.includes(focusId)) : undefined;
  const multiNode = components.filter((ids) => ids.length > 1 && ids !== componentOfFocus);
  const singles = components.filter((ids) => ids.length === 1 && ids[0] !== focusId);

  // The opened cluster first, then the largest ones: a per-node cap on array
  // order used to slice a chain in half and draw the halves as two clusters.
  const ordered = [
    ...(componentOfFocus ? [componentOfFocus] : []),
    ...[...multiNode].sort(
      (left, right) =>
        right.length - left.length ||
        (names.get(left[0]) ?? left[0]).localeCompare(names.get(right[0]) ?? right[0]),
    ),
  ];

  // Each cluster's BFS order, so the cap can slice the opened one and still
  // leave a connected, root-centred picture.
  const planned = ordered.map((ids) => {
    const root = chooseRoot(ids, focusId, degrees, names);
    return { root, order: breadthFirst(ids, visible, root, names) };
  });

  const unlinked = singles
    .map((ids) => nodeById.get(ids[0]) as GraphNode)
    .sort((left, right) => right.degree - left.degree || left.name.localeCompare(right.name));

  const build = (budget: number) => {
    const drawn = new Set<string>();
    const boxes: Box[] = [];
    for (const plan of planned) {
      const remaining = budget - drawn.size;
      if (remaining <= 0) break;
      const take =
        plan.order.length <= remaining
          ? plan.order.length
          : drawn.size === 0
            ? Math.max(1, remaining)
            : 0;
      if (take === 0) continue;
      const slice = plan.order.slice(0, take);
      for (const entry of slice) drawn.add(entry.id);
      boxes.push(radialComponent(slice, names));
    }
    // Boxes carry their own label padding, so the full width is available.
    const packed = packComponents(boxes, Math.max(1, width));
    return { ...packed, drawn, boxes };
  };

  let budget = cap;
  let built = build(budget);
  // Fit at 1:1: shrink the node budget until the drawing fits, rather than
  // scaling below 1, which would squeeze the arcs while the labels stay put.
  while (
    budget > MIN_BUDGET &&
    (built.height > maxHeight || built.width > width) &&
    Math.min(width / Math.max(built.width, 1), maxHeight / Math.max(built.height, 1)) < MIN_SCALE
  ) {
    budget = Math.max(MIN_BUDGET, Math.floor(budget * BUDGET_STEP));
    built = build(budget);
  }

  const naturalWidth = Math.max(built.width, 1);
  const naturalHeight = Math.max(built.height, 1);
  const scale = Math.max(
    0.3,
    Math.min(MAX_UPSCALE, width / naturalWidth, maxHeight / naturalHeight),
  );
  const height = naturalHeight * scale;
  const offsetX = (width - naturalWidth * scale) / 2;
  const offsetY = (height - naturalHeight * scale) / 2;

  const points = new Map<string, LayoutPoint>();
  for (const [id, point] of built.points) {
    points.set(id, { x: offsetX + point.x * scale, y: offsetY + point.y * scale });
  }

  const rendered = nodes.filter((node) => built.drawn.has(node.id));
  const hiddenCount =
    planned.reduce((total, plan) => total + plan.order.length, 0) - built.drawn.size;

  // Labels last, once the scale is known: a name is cut only when the space this
  // node actually got cannot hold it, so a sparse drawing shows whole names and
  // a dense one truncates — instead of every label obeying one character count.
  //
  // The room is horizontal, because a label is centred *under* its node: what it
  // can collide with is another label sharing its text band, which is what
  // gives a two-node vertical chain its full column width instead of the 54px
  // ring step it sits above. A node alone in its band may use the panel.
  const labels = new Map<string, string>();
  const band = LABEL_SIZE + 6;
  for (let index = 0; index < rendered.length; index++) {
    const own = points.get(rendered[index].id);
    if (!own) continue;
    // A centred label of width W stays inside the panel while W/2 ≤ min(x, w−x).
    // Two pixels cover the halo stroke; the estimate already carries slack.
    const panelRoom = 2 * Math.min(own.x, width - own.x) - 2;
    let shared = Infinity;
    for (let other = 0; other < rendered.length; other++) {
      if (other === index) continue;
      const point = points.get(rendered[other].id);
      if (!point || Math.abs(point.y - own.y) > band) continue;
      shared = Math.min(shared, Math.abs(point.x - own.x));
    }
    const room = Number.isFinite(shared) ? Math.min(shared - 4, panelRoom) : Math.max(panelRoom, 0);
    labels.set(rendered[index].id, fitLabel(rendered[index].name, room));
  }

  return { points, rendered, unlinked, hiddenCount, labels, width, height };
}
