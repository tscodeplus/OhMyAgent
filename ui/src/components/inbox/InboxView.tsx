import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { Inbox as InboxIcon, Lock } from 'lucide-react';
import { cn } from '../../lib/utils';
import { fetchInboxSession } from '../../utils/api';
import MessageList from '../chat/MessageList';
import type { MessagePageFetcher } from '../chat/MessageList';
import Spinner from '../ui/Spinner';
import type { InboxSessionDetail } from '../../types/inbox';
import type { Message } from '../../types/session';
import {
  INBOX_CHANNEL_BADGE_CLASS,
  channelLabel,
  normalizeInboxChannel,
  toInboxCursor,
} from './inboxModel';

/**
 * Read-only transcript for one IM-channel session (`/inbox/:sessionId`).
 *
 * The transcript itself is `MessageList` — the same renderer the project chat
 * uses — driven by the inbox endpoint instead of the project-session endpoint.
 * There is deliberately no composer, rename or delete affordance here: the
 * conversation happens inside Feishu/Telegram/WeChat/QQ.
 */
export default function InboxView() {
  const { sessionId } = useParams();
  const { t } = useTranslation('common');
  /** Header-only metadata; the transcript pages are fetched by MessageList. */
  const [header, setHeader] = useState<Omit<InboxSessionDetail, 'messages' | 'hasMore'> | null>(
    null,
  );
  const [loadingHeader, setLoadingHeader] = useState(true);
  const [error, setError] = useState<'notFound' | 'failed' | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setLoadingHeader(true);
    setError(null);
    setHeader(null);
    // limit=1: this call only needs the channel and title, the transcript is
    // paged separately by MessageList.
    fetchInboxSession(sessionId, { limit: 1 })
      .then((data) => {
        if (cancelled) return;
        const { messages: _messages, hasMore: _hasMore, ...meta } = data;
        setHeader(meta);
      })
      .catch((err: { status?: number } | undefined) => {
        if (!cancelled) setError(err?.status === 404 ? 'notFound' : 'failed');
      })
      .finally(() => {
        if (!cancelled) setLoadingHeader(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Paging source for MessageList: the inbox endpoint returns the same message
  // shape as the project-session endpoint, so the renderer needs nothing else.
  const loadPage = useCallback<MessagePageFetcher>(
    async ({ limit, before, beforeId }) => {
      if (!sessionId) return { messages: [] as Message[], hasMore: false };
      const data = await fetchInboxSession(sessionId, {
        limit,
        before: before === undefined ? undefined : toInboxCursor(before),
        beforeId,
      });
      return { messages: data.messages ?? [], hasMore: data.hasMore ?? false };
    },
    [sessionId],
  );

  if (!sessionId) return null;

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-8">
        <div className="text-center">
          <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-neutral-100 dark:bg-neutral-800">
            <InboxIcon
              className="h-8 w-8 text-neutral-400 dark:text-neutral-500"
              strokeWidth={1.5}
            />
          </div>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {error === 'notFound' ? t('inbox.notImSession') : t('common.error')}
          </p>
        </div>
      </div>
    );
  }

  const channel = normalizeInboxChannel(header?.channel ?? 'unknown');
  const title = header?.title || header?.external_chat_id || sessionId;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-200 px-3 py-2 sm:px-4 dark:border-neutral-800">
        <span
          className={cn(
            'inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium',
            INBOX_CHANNEL_BADGE_CLASS[channel],
          )}
        >
          {channelLabel(t, channel, header?.bot_name)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
          {title}
        </span>
        {header?.external_chat_id && header.title && (
          <span className="hidden min-w-0 truncate text-[11px] text-neutral-400 sm:inline dark:text-neutral-500">
            {header.external_chat_id}
          </span>
        )}
        <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-neutral-200 px-1.5 py-0.5 text-[11px] text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          <Lock className="h-3 w-3" strokeWidth={1.75} />
          {t('inbox.readOnly')}
        </span>
      </div>
      <p className="shrink-0 border-b border-neutral-200/70 px-3 py-1 text-[11px] text-neutral-500 sm:px-4 dark:border-neutral-800/70 dark:text-neutral-400">
        {t('inbox.readOnlyNotice')}
      </p>

      {loadingHeader && !header ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner size="sm" />
        </div>
      ) : (
        <MessageList
          key={sessionId}
          sessionId={sessionId}
          loadPage={loadPage}
          readOnly
          emptyStateText={t('inbox.emptyMessages')}
        />
      )}
    </div>
  );
}
