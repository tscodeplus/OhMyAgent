import type { ReactNode } from 'react';

/**
 * A markdown table in its own horizontal scroller.
 *
 * A `<table>` cannot be its own scroller without giving up its width: making it
 * `display: block` + `overflow-x: auto` lets a two-column table collapse to a 91px
 * stub, because the anonymous table box inside a block shrinks to its content. A
 * `<div>` around it can scroll while the table keeps `width: 100%`, so a narrow table
 * still reads as part of the prose while a ten-column one scrolls inside the message
 * (or the notes card) instead of pushing the whole pane sideways.
 *
 * Registered as the `table` renderer by every `ReactMarkdown` call site (chat bubble,
 * notes body, toast, harness card), because no CSS alone can put a scroller between a
 * table and its parent.
 */
export default function MarkdownTable({ children }: { children?: ReactNode }) {
  return (
    <div className="md-table-scroll">
      <table>{children}</table>
    </div>
  );
}
