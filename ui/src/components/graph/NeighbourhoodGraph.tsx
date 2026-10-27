import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { GraphEdge, GraphNode } from '../../types/graph';

/** Fixed drawing space: layout is computed once here, the SVG scales to fit. */
const CANVAS = 600;
const PAD = 36;
/** Below this distance two node labels overlap — the repulsion floor. */
const MIN_GAP = 34;
/** Edge rest length; short enough that a handful of nodes fills the canvas. */
const SPRING = 110;
/**
 * Rendering cap. The API happily returns 200 nodes, but a 200-node drawing at
 * 320px is noise: past this point the panel says "showing the first N".
 */
const MAX_RENDERED = 40;

interface Position {
  x: number;
  y: number;
}

/**
 * Force relaxation seeded on a circle: repulsion between every pair, spring
 * along every edge, clamped inside the canvas.
 *
 * O(n²) per step is fine because the input is capped at MAX_RENDERED — a real
 * force-directed library would be a new dependency for ~40 lines of arithmetic.
 */
function layoutNodes(nodes: GraphNode[], edges: GraphEdge[]): Map<string, Position> {
  const centre = CANVAS / 2;
  const radius = centre - PAD - 10;
  const points = nodes.map((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(1, nodes.length) - Math.PI / 2;
    return {
      id: node.id,
      x: centre + radius * Math.cos(angle),
      y: centre + radius * Math.sin(angle),
    };
  });
  const indexById = new Map(points.map((point, index) => [point.id, index]));
  const links = edges
    .map((edge) => [indexById.get(edge.source), indexById.get(edge.target)] as const)
    .filter(
      (pair): pair is readonly [number, number] =>
        pair[0] !== undefined && pair[1] !== undefined && pair[0] !== pair[1],
    );

  const STEPS = 180;
  for (let step = 0; step < STEPS; step++) {
    const cooling = 1 - step / STEPS;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const dx = points[j].x - points[i].x;
        const dy = points[j].y - points[i].y;
        const distance = Math.hypot(dx, dy) || 0.01;
        if (distance >= MIN_GAP * 2) continue;
        const push = ((MIN_GAP - distance) / distance) * cooling * 0.5;
        points[i].x -= dx * push;
        points[i].y -= dy * push;
        points[j].x += dx * push;
        points[j].y += dy * push;
      }
    }
    for (const [from, to] of links) {
      const dx = points[to].x - points[from].x;
      const dy = points[to].y - points[from].y;
      const distance = Math.hypot(dx, dy) || 0.01;
      const pull = ((distance - SPRING) / distance) * cooling * 0.2;
      points[from].x += dx * pull;
      points[from].y += dy * pull;
      points[to].x -= dx * pull;
      points[to].y -= dy * pull;
    }
    for (const point of points) {
      point.x = Math.min(CANVAS - PAD, Math.max(PAD, point.x));
      point.y = Math.min(CANVAS - PAD, Math.max(PAD, point.y));
    }
  }

  return new Map(points.map((point) => [point.id, { x: point.x, y: point.y }]));
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
    () => layoutNodes(visibleNodes, visibleEdges),
    [visibleNodes, visibleEdges],
  );

  return (
    <div>
      <svg
        viewBox={`0 0 ${CANVAS} ${CANVAS}`}
        className="w-full select-none"
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
          const radius = 8 + Math.min(node.degree, 8);
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
                strokeWidth={1.5}
              />
              <text
                x={position.x}
                y={position.y + radius + 14}
                textAnchor="middle"
                fontSize={12}
                className={
                  isFocus
                    ? 'fill-neutral-900 font-medium dark:fill-neutral-100'
                    : 'fill-neutral-600 dark:fill-neutral-300'
                }
              >
                {node.name.length > 12 ? `${node.name.slice(0, 12)}…` : node.name}
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
