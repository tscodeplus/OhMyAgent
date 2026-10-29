import { useTranslation } from 'react-i18next';
import { compactScopeLabel } from './scope-label';

/**
 * The scope chip shown beside a page's type/status.
 *
 * `global` renders as a translated label because it means "readable everywhere",
 * while a chat scope renders as `feishu · oc_1` — a reviewer deciding whether to
 * approve a shadow page needs to know who proposed it before the body, and the
 * `title` keeps the exact stored address one hover away.
 *
 * Not a control: the console never writes into a chat (`knowledge-routes.ts`
 * sends no scope), so there is nothing to pick here.
 */
export default function KnowledgeScopeBadge({ scope }: { scope: string }) {
  const { t } = useTranslation('common');
  const raw = scope.trim();
  const global = raw === '' || raw === 'global';

  return (
    <span
      title={raw}
      className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
    >
      {global ? t('knowledge.scopes.global') : compactScopeLabel(raw)}
    </span>
  );
}
