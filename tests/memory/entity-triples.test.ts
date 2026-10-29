/**
 * Triple extraction (`extractTriplesLLM` in `src/memory/entity-extractor.ts`).
 *
 * This layer decides what may be *written*, so unlike the graph gates it fails
 * closed: a triple needs both endpoints in the text, a relation from the
 * vocabulary, and — when the model quotes one — an evidence span that contains
 * both names. The tests below are the measured refusals that motivated each gate,
 * plus the one distinction the old shape got wrong: "the model found no relation"
 * is a success, not a failure.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { extractTriplesLLM } from '../../src/memory/entity-extractor';
import type { LLMExtractionConfig } from '../../src/memory/entity-extractor';
import type { AuxModelConfig } from '../../src/memory/aux-llm-client';

const auxLLMCall = vi.fn();
vi.mock('../../src/memory/aux-llm-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/memory/aux-llm-client.js')>();
  return { ...actual, auxLLMCall: (...args: unknown[]) => auxLLMCall(...args) };
});

const AUX_CONFIG: AuxModelConfig = { modelRef: 'test/model' };
const logger = { debug() {}, info() {}, warn() {}, error() {} } as never;
const config: LLMExtractionConfig = {
  auxConfig: AUX_CONFIG,
  enabled: true,
  minConfidence: 0.6,
  logger,
};

function modelReturns(payload: unknown): void {
  auxLLMCall.mockResolvedValue(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

async function extract(text: string, onFallback?: (reason: string) => void) {
  return extractTriplesLLM(text, config, { logger, onFallback } as never);
}

describe('extractTriplesLLM', () => {
  beforeEach(() => auxLLMCall.mockReset());
  afterEach(() => auxLLMCall.mockReset());

  it('keeps a triple whose evidence quotes both names', async () => {
    const text = '用户要求通过 excel-mcp 使用 Power Query 读取 Excel 文件';
    modelReturns([
      {
        subject: 'excel-mcp',
        relation: 'USES',
        object: 'Power Query',
        evidence: '通过 excel-mcp 使用 Power Query',
        confidence: 0.9,
      },
    ]);

    const triples = await extract(text);
    expect(triples).toEqual([
      {
        subject: 'excel-mcp',
        relation: 'USES',
        object: 'Power Query',
        evidence: '通过 excel-mcp 使用 Power Query',
        confidence: 0.9,
      },
    ]);
  });

  it('refuses a subject the quoted span does not contain', async () => {
    // Measured on the reference corpus: the model answered
    // `Excel 相关操作 —USES→ excel-mcp`, with the evidence quoting only the target.
    const text = '用户要求通过 excel-mcp 使用 Power Query 读取 Excel 文件';
    modelReturns([
      {
        subject: 'Excel 相关操作',
        relation: 'USES',
        object: 'excel-mcp',
        evidence: '通过 excel-mcp 使用 Power Query',
        confidence: 0.95,
      },
    ]);

    expect(await extract(text)).toEqual([]);
  });

  it('refuses an evidence span that is not in the text', async () => {
    const text = '通过 excel-mcp 使用 Power Query 读取文件';
    modelReturns([
      {
        subject: 'excel-mcp',
        relation: 'USES',
        object: 'Power Query',
        evidence: 'excel-mcp 调用 Power Query 的接口',
        confidence: 0.9,
      },
    ]);

    expect(await extract(text)).toEqual([]);
  });

  it('refuses a relation outside the vocabulary', async () => {
    const text = '通过 excel-mcp 使用 Power Query 读取文件';
    modelReturns([
      {
        subject: 'excel-mcp',
        relation: 'READS',
        object: 'Power Query',
        evidence: '通过 excel-mcp 使用 Power Query',
        confidence: 0.9,
      },
    ]);

    expect(await extract(text)).toEqual([]);
  });

  it('refuses a fragment sliced out of a longer word', async () => {
    const text = '请问如何称呼你比较合适';
    modelReturns([
      {
        subject: '何称',
        relation: 'ADVISES',
        object: '称呼',
        evidence: '如何称呼',
        confidence: 0.9,
      },
    ]);

    expect(await extract(text)).toEqual([]);
  });

  it('refuses a filename as an endpoint', async () => {
    // Measured: `file_info.xlsx —USES→ excel-mcp`, which is true of nobody.
    const text = '代理已创建 file_info.xlsx 并用 excel-mcp 打开';
    modelReturns([
      {
        subject: 'file_info.xlsx',
        relation: 'USES',
        object: 'excel-mcp',
        evidence: '创建 file_info.xlsx 并用 excel-mcp',
        confidence: 0.9,
      },
    ]);

    expect(await extract(text)).toEqual([]);
  });

  it('accepts a triple with no evidence when both names are in the text', async () => {
    const text = 'Power Query 依赖 Excel 才能运行';
    modelReturns([
      { subject: 'Power Query', relation: 'DEPENDS_ON', object: 'Excel', confidence: 0.8 },
    ]);

    expect(await extract(text)).toHaveLength(1);
  });

  it('reads alternate key spellings from the model', async () => {
    const text = 'Power Query 依赖 Excel 才能运行';
    modelReturns([
      { source: 'Power Query', predicate: 'DEPENDS_ON', target: 'Excel', confidence: 0.8 },
    ]);

    expect((await extract(text))[0]).toMatchObject({
      subject: 'Power Query',
      relation: 'DEPENDS_ON',
      object: 'Excel',
    });
  });

  it('treats "no relation stated" as success, not as a failure', async () => {
    const text = '用户偏好简短回复';
    modelReturns([]);
    const onFallback = vi.fn();

    expect(await extract(text, onFallback)).toEqual([]);
    // The old shape reported this as `llm_empty` and counted it against the
    // failure ledger, which is how a healthy run looked broken.
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('reports a genuinely unparseable answer as llm_empty', async () => {
    modelReturns('I could not find any relations in this text.');
    const onFallback = vi.fn();

    await extract('用户偏好简短回复', onFallback);
    expect(onFallback).toHaveBeenCalledWith('llm_empty');
  });

  it('reports a thrown call as llm_error', async () => {
    auxLLMCall.mockRejectedValue(new Error('boom'));
    const onFallback = vi.fn();

    await extract('Power Query 依赖 Excel', onFallback);
    expect(onFallback).toHaveBeenCalledWith('llm_error');
  });

  it('skips a JSON record without spending a call', async () => {
    const onFallback = vi.fn();
    const triples = await extract(
      '{"version":6,"summary":"偏好简洁沟通","tools":["excel-mcp"]}',
      onFallback,
    );

    expect(triples).toEqual([]);
    expect(auxLLMCall).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('skips a truncated JSON record too', async () => {
    // The profile distiller truncates; `JSON.parse` would miss exactly this case.
    const triples = await extract('{"version":6,"summary":"偏好简洁沟通","tools":["excel');
    expect(triples).toEqual([]);
    expect(auxLLMCall).not.toHaveBeenCalled();
  });

  it('dedupes the same statement repeated by the model', async () => {
    const text = '通过 excel-mcp 使用 Power Query 读取文件';
    const triple = {
      subject: 'excel-mcp',
      relation: 'USES',
      object: 'Power Query',
      evidence: '通过 excel-mcp 使用 Power Query',
      confidence: 0.9,
    };
    modelReturns([triple, { ...triple, subject: 'excel-mcp ' }]);

    expect(await extract(text)).toHaveLength(1);
  });

  it('drops a self-loop', async () => {
    const text = 'Power Query 是 Excel 的一部分';
    modelReturns([
      {
        subject: 'Power Query',
        relation: 'USES',
        object: 'Power Query',
        evidence: 'Power Query 是 Excel 的一部分',
        confidence: 0.9,
      },
    ]);

    expect(await extract(text)).toEqual([]);
  });
});
