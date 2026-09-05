import { describe, it, expect } from 'vitest';
import {
  detectIntentDomain,
  isToolVisibleForIntent,
  type IntentDomain,
} from '../../src/agent/intent.js';

describe('detectIntentDomain', () => {
  it('returns undefined for empty or very long messages', () => {
    expect(detectIntentDomain('')).toBeUndefined();
    expect(detectIntentDomain('   ')).toBeUndefined();
    expect(detectIntentDomain('x'.repeat(501))).toBeUndefined();
  });

  it('detects code domain (zh + en)', () => {
    expect(detectIntentDomain('帮我跑一下测试')?.domain).toBe('code');
    expect(detectIntentDomain('修复一下这个 bug 报错')?.domain).toBe('code');
    expect(detectIntentDomain('please refactor this code and run the test')?.domain).toBe('code');
  });

  it('detects web domain', () => {
    expect(detectIntentDomain('搜索一下今天的新闻')?.domain).toBe('web');
    expect(detectIntentDomain('search for the latest rust release')?.domain).toBe('web');
  });

  it('detects multimedia domain', () => {
    expect(detectIntentDomain('帮我生成一张图片')?.domain).toBe('multimedia');
    expect(detectIntentDomain('draw an image of a cat')?.domain).toBe('multimedia');
  });

  it('detects memory domain', () => {
    expect(detectIntentDomain('记住我喜欢喝美式咖啡')?.domain).toBe('memory');
    expect(detectIntentDomain('remember that I prefer dark mode')?.domain).toBe('memory');
  });

  it('detects project-management domain', () => {
    expect(detectIntentDomain('提醒我明天下午三点开会')?.domain).toBe('project-management');
    expect(detectIntentDomain('add a todo for the release')?.domain).toBe('project-management');
  });

  it('detects bare-chat for short social filler', () => {
    expect(detectIntentDomain('你好')?.domain).toBe('bare-chat');
    expect(detectIntentDomain('谢谢！')?.domain).toBe('bare-chat');
    expect(detectIntentDomain('hello!')?.domain).toBe('bare-chat');
    expect(detectIntentDomain('👍')?.domain).toBe('bare-chat');
  });

  it('returns undefined for ordinary task messages with no confident domain', () => {
    // No keyword hit, no chitchat pattern → keep full profile surface
    expect(detectIntentDomain('帮我把这份文档总结一下要点')).toBeUndefined();
  });

  it('does not classify long social-ish messages as bare-chat', () => {
    expect(detectIntentDomain('你好'.repeat(40))).toBeUndefined(); // > 60 chars
  });
});

describe('isToolVisibleForIntent', () => {
  it('always keeps forced-core tools (bridges + IM interaction)', () => {
    for (const domain of ['bare-chat', 'code', 'web'] as IntentDomain[]) {
      expect(isToolVisibleForIntent('tool_search', domain)).toBe(true);
      expect(isToolVisibleForIntent('tool_call', domain)).toBe(true);
      expect(isToolVisibleForIntent('ask_user_question', domain)).toBe(true);
      expect(isToolVisibleForIntent('send_message', domain)).toBe(true);
    }
  });

  it('bare-chat narrows to memory + session basics only', () => {
    expect(isToolVisibleForIntent('memory_recall', 'bare-chat')).toBe(true);
    expect(isToolVisibleForIntent('session_summarize', 'bare-chat')).toBe(true);
    expect(isToolVisibleForIntent('shell', 'bare-chat')).toBe(false);
    expect(isToolVisibleForIntent('web_search', 'bare-chat')).toBe(false);
    expect(isToolVisibleForIntent('file_write', 'bare-chat')).toBe(false);
  });

  it('code domain keeps file/shell family, drops web/media', () => {
    expect(isToolVisibleForIntent('file_read', 'code')).toBe(true);
    expect(isToolVisibleForIntent('file_edit', 'code')).toBe(true);
    expect(isToolVisibleForIntent('grep', 'code')).toBe(true);
    expect(isToolVisibleForIntent('shell', 'code')).toBe(true);
    expect(isToolVisibleForIntent('web_search', 'code')).toBe(false);
    expect(isToolVisibleForIntent('image_generation', 'code')).toBe(false);
  });

  it('web domain keeps web family, drops shell', () => {
    expect(isToolVisibleForIntent('web_search', 'web')).toBe(true);
    expect(isToolVisibleForIntent('web_fetch', 'web')).toBe(true);
    expect(isToolVisibleForIntent('download_file', 'web')).toBe(true);
    expect(isToolVisibleForIntent('shell', 'web')).toBe(false);
  });

  it('multimedia domain keeps media generation and channel senders', () => {
    expect(isToolVisibleForIntent('image_generation', 'multimedia')).toBe(true);
    expect(isToolVisibleForIntent('image-generation', 'multimedia')).toBe(true);
    expect(isToolVisibleForIntent('video_generation', 'multimedia')).toBe(true);
    expect(isToolVisibleForIntent('feishu_send_media', 'multimedia')).toBe(true);
    expect(isToolVisibleForIntent('shell', 'multimedia')).toBe(false);
  });

  it('memory domain keeps the memory family', () => {
    expect(isToolVisibleForIntent('memory_recall', 'memory')).toBe(true);
    expect(isToolVisibleForIntent('memory_store', 'memory')).toBe(true);
    expect(isToolVisibleForIntent('memory_doctor', 'memory')).toBe(true);
    expect(isToolVisibleForIntent('shell', 'memory')).toBe(false);
  });

  it('project-management keeps task/todo/cron/brief family', () => {
    expect(isToolVisibleForIntent('task_create', 'project-management')).toBe(true);
    expect(isToolVisibleForIntent('task_get', 'project-management')).toBe(true);
    expect(isToolVisibleForIntent('todo_write', 'project-management')).toBe(true);
    expect(isToolVisibleForIntent('brief', 'project-management')).toBe(true);
    expect(isToolVisibleForIntent('shell', 'project-management')).toBe(false);
  });
});
