// 从工具返回值中提取文本内容
export function extractToolText(result: any): string {
  const content = result?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c?.type === 'text')
      .map((c: any) => c.text)
      .join('\n');
  }
  return String(content ?? '');
}

// 断言工具结果包含指定文本
export function expectToolResultContains(result: any, expected: string): void {
  expect(extractToolText(result)).toContain(expected);
}
