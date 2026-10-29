import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { GraphEdge, GraphNode } from '../../types/graph';

/** Fixed drawing space: layout is computed once here, the SVG scales to fit. */
const CANVAS = 600;
/** Room for a node's label, which is centred *below* the circle. */
const PAD = 56;
/** One node's drawing radius. Fixed, so the overview and a neighbourhood agree. */
const NODE_RADIUS = 10;
/** The entity the user clicked, drawn a touch heavier than its neighbours. */
const FOCUS_RADIUS = 12;
/** Minimum centre-to-centre distance inside one component. */
const NODE_GAP = 44;
/** Breathing room between two components on the shelf, wide enough for labels. */
const COMPONENT_PAD = 34;
const LABEL_SIZE = 14;
const LABEL_MAX_CHARS = 8;
/**
 * Rendering cap. The API happily returns 200 nodes, but a 200-node drawing at
 * 320px is noise: past this point the panel says "showing the first N".
 */
const MAX_RENDERED = 40;

interface Position {
  x: number;
  y: number;
}

/** Union-find over the visible edges: one group per connected cluster. */
function findComponents(nodes: GraphNode[], edges: GraphEdge[]): string[][] {
  const parent = new Map<string, string>();
  for (const node of nodes) parent.set(node.id, node.id);
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
  for (const node of nodes) {
    const root = find(node.id);
    const group = groups.get(root);
    if (group) group.push(node.id);
    else groups.set(root, [node.id]);
  }
  return [...groups.values()];
}

/**
 * Order a component's nodes by walking its own edges from a start node.
 *
 * The ring is drawn in this order, so a chain A—B—C puts B between A and C
 * instead of scattering the three around the circle with chords crossing the
 * middle. Nodes no edge reaches keep their input order at the end.
 */
function ringOrder(ids: string[], edges: GraphEdge[], preferred?: string): string[] {
  const adjacency = new Map<string, string[]>();
  for (const id of ids) adjacency.set(id, []);
  for (const edge of edges) {
    const from = adjacency.get(edge.source);
    const to = adjacency.get(edge.target);
    if (!from || !to) continue;
    from.push(edge.target);
    to.push(edge.source);
  }
  const start = preferred && adjacency.has(preferred) ? preferred : ids[0];
  const seen = new Set([start]);
  const order = [start];
  for (let index = 0; index < order.length; index++) {
    for (const next of adjacency.get(order[index]) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      order.push(next);
    }
  }
  for (const id of ids) if (!seen.has(id)) order.push(id);
  return order;
}

/**
 * Lay the graph out cluster by cluster, then pack the clusters onto a shelf.
 *
 * The previous version was one force relaxation over every node: springs pulled
 * each connected group to a rest length while repulsion only acted below a
 * threshold, so several small groups — the ordinary shape of a knowledge graph,
 * where most names are mentioned and connected to nothing — drifted on top of
 * each other. Everything overlapping is indistinguishable from a broken drawing.
 *
 * Separating the two steps fixes that by construction: a component's shape is
 * computed in its own local space (a ring, which keeps a chain's edges short and
 * visible), then the components are packed side by side with a gap that no force
 * can violate. It is also deterministic, so the same data always draws the same
 * picture — a force layout re-simulated on every render does not.
 */
function layoutNodes(
  nodes: GraphNode[],
  edges: GraphEdge[],
  focusId?: string,
): Map<string, Position> {
  const boxes = findComponents(nodes, edges).map((ids) => {
    const members = new Set(ids);
    const compEdges = edges.filter((edge) => members.has(edge.source) && members.has(edge.target));
    // A ring long enough that neighbours keep NODE_GAP apart: circumference ≥ n·gap.
    const radius =
      ids.length === 1 ? 0 : Math.max(NODE_GAP, (ids.length * NODE_GAP) / (Math.PI * 2));
    return {
      order: ringOrder(ids, compEdges, focusId),
      radius,
      /** Local bounding box, used only for packing. */
      size: radius * 2,
    };
  });

  // Largest first: a big cluster needs a contiguous shelf slot, and leftover
  // space at the end of a row should go to a small one.
  boxes.sort((left, right) => right.size - left.size);

  const available = CANVAS - PAD * 2;
  const placed: Array<{ centreX: number; centreY: number; box: (typeof boxes)[number] }> = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  for (const box of boxes) {
    const cellWidth = box.size + COMPONENT_PAD * 2;
    const cellHeight = box.size + COMPONENT_PAD * 2;
    if (cursorX > 0 && cursorX + cellWidth > available) {
      cursorX = 0;
      cursorY += rowHeight;
      rowHeight = 0;
    }
    placed.push({
      centreX: cursorX + cellWidth / 2,
      centreY: cursorY + cellHeight / 2,
      box,
    });
    cursorX += cellWidth;
    rowHeight = Math.max(rowHeight, cellHeight);
  }

  const points = placed.flatMap(({ centreX, centreY, box }) =>
    box.order.map((id, index) => {
      // Starting at the top keeps the drawing's orientation stable between
      // renders; a single-node component sits exactly at its cell's centre.
      const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(1, box.order.length);
      return {
        id,
        x: centreX + box.radius * Math.cos(angle),
        y: centreY + box.radius * Math.sin(angle),
      };
    }),
  );

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const width = Math.max(...xs) - minX;
  const height = Math.max(...ys) - minY;
  // Only a graph too large for the canvas shrinks; everything else is drawn at
  // the same scale, so a node's size does not depend on how much was in view.
  const scale = Math.min(1, available / Math.max(width, 1), available / Math.max(height, 1));

  return new Map(
    points.map((point) => [
      point.id,
      {
        x: PAD + (point.x - minX) * scale + (available - width * scale) / 2,
        y: PAD + (point.y - minY) * scale + (available - height * scale) / 2,
      },
    ]),
  );
}

interface NeighbourhoodGraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The entity the layout is centred on; its node is drawn emphasised. */
  focusId?: string;
  onSelect: (entityId: string) => void;
}

export default function NeighbourhoodGraph({
  nodes,
  edges,
  focusId,
  onSelect,
}: NeighbourhoodGraphProps) {
  const { t } = useTranslation('common');

  // The focused entity must survive the cap — it is what the user clicked.
  const visibleNodes = useMemo(() => {
    const ranked = focusId
      ? [...nodes].sort((a, b) => (a.id === focusId ? -1 : b.id === focusId ? 1 : 0))
      : nodes;
    return ranked.slice(0, MAX_RENDERED);
  }, [nodes, focusId]);

  const visibleIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)),
    [edges, visibleIds],
  );
  const positions = useMemo(
    () => layoutNodes(visibleNodes, visibleEdges, focusId),
    [visibleNodes, visibleEdges, focusId],
  );

  return (
    <div>
      <svg
        viewBox={`0 0 ${CANVAS} ${CANVAS}`}
        // Bounded on both axes by a max width, not by a height cap: a height cap
        // on a wide screen shrinks every unit of the drawing (nodes and labels
        // included), which is what made a legible graph unreadable.
        className="w-full max-w-[720px] select-none"
        role="img"
        aria-label={t('graph.canvasLabel')}
      >
        {visibleEdges.map((edge) => {
          const from = positions.get(edge.source);
          const to = positions.get(edge.target);
          if (!from || !to) return null;
          return (
            <line
              key={edge.id}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              className="stroke-neutral-300 dark:stroke-neutral-700"
              strokeWidth={1.5}
              // Retracted facts stay visible but dashed: the relation is
              // history, not a current truth.
              strokeDasharray={edge.valid_to !== undefined ? '5 5' : undefined}
            />
          );
        })}
        {visibleNodes.map((node) => {
          const position = positions.get(node.id);
          if (!position) return null;
          const isFocus = node.id === focusId;
          // Fixed radius, not one scaled by degree: the overview's busiest nodes
          // used to be drawn at twice a neighbourhood node's size, so the same
          // entity changed size depending on how you arrived at it.
          const radius = isFocus ? FOCUS_RADIUS : NODE_RADIUS;
          return (
            <g
              key={node.id}
              onClick={() => onSelect(node.id)}
              className="cursor-pointer"
              role="button"
              tabIndex={0}
              aria-label={t('graph.nodeAria', { name: node.name })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(node.id);
                }
              }}
            >
              <title>{node.name}</title>
              <circle
                cx={position.x}
                cy={position.y}
                r={radius}
                className={
                  isFocus
                    ? 'fill-blue-500/80 stroke-blue-600 dark:fill-blue-400/80 dark:stroke-blue-300'
                    : 'fill-neutral-200 stroke-neutral-400 hover:fill-neutral-300 dark:fill-neutral-700 dark:stroke-neutral-500 dark:hover:fill-neutral-600'
                }
                strokeWidth={1.25}
              />
              <text
                x={position.x}
                y={position.y + radius + LABEL_SIZE + 2}
                textAnchor="middle"
                fontSize={LABEL_SIZE}
                className={
                  isFocus
                    ? 'fill-neutral-900 font-medium dark:fill-neutral-100'
                    : 'fill-neutral-600 dark:fill-neutral-300'
                }
              >
                {node.name.length > LABEL_MAX_CHARS
                  ? `${node.name.slice(0, LABEL_MAX_CHARS)}…`
                  : node.name}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400">
        {visibleNodes.length < nodes.length && (
          <span>{t('graph.showingFirst', { count: visibleNodes.length })}</span>
        )}
        <span>{t('graph.clickHint')}</span>
      </div>
    </div>
  );
}
