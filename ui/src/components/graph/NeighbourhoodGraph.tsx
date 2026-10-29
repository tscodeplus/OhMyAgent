import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GraphEdge, GraphNode } from '../../types/graph';
import { FOCUS_RADIUS, LABEL_SIZE, MAX_RENDERED, NODE_RADIUS, layoutGraph } from './layout';

/** Width before the panel has been measured (a phone column is ~344px). */
const FALLBACK_WIDTH = 360;
/** Share of the viewport the drawing may take; the rest scrolls. */
const HEIGHT_FRACTION = 0.6;
const MIN_HEIGHT_BUDGET = 200;
/** Names listed under the canvas before the list is cut with a "+N". */
const CHIP_LIMIT = 14;

interface PanelSize {
  width: number;
  maxHeight: number;
}

/**
 * Tracks the drawing's real pixel box.
 *
 * The layout is computed in CSS pixels and the `viewBox` is that same box, so
 * one SVG unit is one pixel. Measuring is therefore not cosmetic: it is what
 * keeps a 10px label 10px on a phone and on a 4K desktop. A fixed 600-unit box
 * stretched with `w-full` is what made the same graph render its labels at ~7px
 * on one screen and ~18px on another.
 */
function usePanelSize(host: React.RefObject<HTMLDivElement | null>): PanelSize {
  const [size, setSize] = useState<PanelSize>({
    width: FALLBACK_WIDTH,
    maxHeight: 400,
  });

  useEffect(() => {
    const measure = () => {
      const width = host.current?.clientWidth ?? 0;
      setSize({
        width: Math.max(240, Math.round(width) || FALLBACK_WIDTH),
        maxHeight: Math.max(MIN_HEIGHT_BUDGET, Math.round(window.innerHeight * HEIGHT_FRACTION)),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (host.current) observer.observe(host.current);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [host]);

  return size;
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
  const hostRef = useRef<HTMLDivElement | null>(null);
  const size = usePanelSize(hostRef);

  const layout = useMemo(
    () =>
      layoutGraph({
        nodes,
        edges,
        focusId,
        width: size.width,
        maxHeight: size.maxHeight,
        maxNodes: MAX_RENDERED,
      }),
    [nodes, edges, focusId, size.width, size.maxHeight],
  );

  const visible = layout.rendered;

  return (
    <div ref={hostRef} className="w-full">
      {layout.points.size > 0 && (
        <svg
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className="block w-full select-none"
          role="img"
          aria-label={t('graph.canvasLabel')}
        >
          {edges.map((edge) => {
            const from = layout.points.get(edge.source);
            const to = layout.points.get(edge.target);
            if (!from || !to) return null;
            return (
              <line
                key={edge.id}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                className="stroke-neutral-300 dark:stroke-neutral-700"
                strokeWidth={1}
                // Retracted facts stay visible but dashed: the relation is
                // history, not a current truth.
                strokeDasharray={edge.valid_to !== undefined ? '4 4' : undefined}
              />
            );
          })}
          {visible.map((node) => {
            const position = layout.points.get(node.id);
            if (!position) return null;
            const isFocus = node.id === focusId;
            const radius = isFocus ? FOCUS_RADIUS : NODE_RADIUS;
            // Empty when even one character plus an ellipsis would collide; the
            // node keeps its `<title>` tooltip either way.
            const label = layout.labels.get(node.id) ?? '';
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
                {/* An invisible hit target: a 3.5px dot is not a tap target. */}
                <circle cx={position.x} cy={position.y} r={FOCUS_RADIUS + 6} fill="transparent" />
                <circle
                  cx={position.x}
                  cy={position.y}
                  r={radius}
                  className={
                    isFocus
                      ? 'fill-blue-500 stroke-blue-600 dark:fill-blue-400 dark:stroke-blue-300'
                      : 'fill-neutral-300 stroke-neutral-400 dark:fill-neutral-600 dark:stroke-neutral-500'
                  }
                  strokeWidth={1}
                />
                <text
                  x={position.x}
                  y={position.y + radius + LABEL_SIZE + 1}
                  textAnchor="middle"
                  fontSize={LABEL_SIZE}
                  strokeWidth={3}
                  paintOrder="stroke"
                  className={
                    isFocus
                      ? 'fill-neutral-900 stroke-white font-medium dark:fill-neutral-100 dark:stroke-neutral-900'
                      : 'fill-neutral-600 stroke-white dark:fill-neutral-300 dark:stroke-neutral-900'
                  }
                >
                  {label}
                </text>
              </g>
            );
          })}
        </svg>
      )}

      {layout.unlinked.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            {t('graph.unlinkedCount', { count: layout.unlinked.length })}
          </span>
          {layout.unlinked.slice(0, CHIP_LIMIT).map((node) => (
            <button
              key={node.id}
              type="button"
              onClick={() => onSelect(node.id)}
              title={node.name}
              className="group inline-flex max-w-[11rem] cursor-pointer items-center gap-1.5 text-xs text-neutral-600 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
            >
              {/* Same dot as a drawn node, so the list reads as the part of the
                  graph that has no edge to show rather than as a form field. */}
              <span
                aria-hidden
                className="h-[9px] w-[9px] shrink-0 rounded-full bg-neutral-300 group-hover:bg-neutral-500 dark:bg-neutral-600 dark:group-hover:bg-neutral-400"
              />
              {/* The list is not a drawing: it has the panel's width to wrap
                  into, so the name is shown whole and only the CSS ellipsis
                  clips it when the button itself runs out of room. */}
              <span className="truncate">{node.name}</span>
            </button>
          ))}
          {layout.unlinked.length > CHIP_LIMIT && (
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              +{layout.unlinked.length - CHIP_LIMIT}
            </span>
          )}
        </div>
      )}

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400">
        {layout.hiddenCount > 0 && (
          <span>
            {t('graph.showingFirst', {
              shown: layout.rendered.length,
              hidden: layout.hiddenCount,
            })}
          </span>
        )}
        <span>{t('graph.clickHint')}</span>
      </div>
    </div>
  );
}
