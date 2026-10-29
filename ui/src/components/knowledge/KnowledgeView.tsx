import { useEffect } from 'react';
import { cn } from '../../lib/utils';
import KnowledgePageList, { type KnowledgeSelection } from './KnowledgePageList';
import KnowledgePageEditor from './KnowledgePageEditor';
import type { KnowledgePagePayload } from './types';

interface KnowledgePagesTabProps {
  /**
   * Route-owned selection (`/knowledge/pages/:pageId`). The URL is the single
   * source of truth so a search hit and a list click land on the same state —
   * and so "open this page" is a link, not a piece of component memory.
   */
  pageId: string | null;
  /**
   * The list row that produced `pageId`, when the click came from the list. An
   * archived page's body is only served by the list response (`GET /page/:id` is
   * active-only), so the row has to travel with the navigation.
   */
  cachedPage?: KnowledgePagePayload;
  /** Bumped by the hub after a save / approve / archive, to refetch. */
  refreshKey: number;
  onSelectPage: (selection: KnowledgeSelection | null) => void;
  /** Opens an entity node in the graph tab (`knowledge_pages.entity_id`). */
  onOpenEntity: (entityId: string) => void;
  onChanged: () => void;
  /** Unsaved editor text, so the hub can warn before navigating away. */
  onDirtyChange: (dirty: boolean) => void;
}

/**
 * The browse/edit half of the knowledge hub: a list column and an editor column.
 *
 * It used to own the page header, the stats and the tabs. Those moved up to
 * `KnowledgeHubView` when the graph became a sibling tab — the counts and the
 * search box are now shared by both, and two headers disagreeing about the same
 * numbers is how a merged page starts lying.
 */
export default function KnowledgeView({
  pageId,
  cachedPage,
  refreshKey,
  onSelectPage,
  onOpenEntity,
  onChanged,
  onDirtyChange,
}: KnowledgePagesTabProps) {
  // Mobile: the list and the editor share the column, so one is shown at a time.
  // Derived from the selection rather than kept in state — a second copy of "is
  // the editor open" is exactly what goes out of sync with a URL-driven page.
  const mobileEditor = pageId !== null;

  // Nothing is selected, so nothing can be dirty. Without this a leftover `true`
  // from the last page would block the next navigation with a prompt nobody can
  // satisfy.
  useEffect(() => {
    if (pageId === null) onDirtyChange(false);
  }, [pageId, onDirtyChange]);

  const selection: KnowledgeSelection | null = pageId ? { id: pageId, page: cachedPage } : null;

  return (
    <div className="flex min-h-0 flex-1">
      {/* No page selected → the list owns the whole width. An empty editor panel
          is a placeholder that eats half a screen and shrinks the list for
          nothing; the split appears when there is something to read. */}
      <div
        className={cn(
          'flex min-h-0 flex-col',
          selection
            ? 'w-full shrink-0 border-r border-neutral-200 max-sm:border-r-0 sm:w-96 md:w-[26rem] dark:border-neutral-800'
            : 'w-full',
          mobileEditor && 'max-sm:hidden',
        )}
      >
        <KnowledgePageList
          selectedId={pageId}
          onSelect={(next) => onSelectPage(next)}
          refreshKey={refreshKey}
        />
      </div>
      {selection && (
        <div className="flex min-h-0 flex-1 flex-col">
          <KnowledgePageEditor
            key={selection.id}
            selection={selection}
            onClose={() => onSelectPage(null)}
            onSaved={onChanged}
            onDirtyChange={onDirtyChange}
            onOpenEntity={onOpenEntity}
          />
        </div>
      )}
    </div>
  );
}
