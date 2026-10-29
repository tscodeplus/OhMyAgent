/**
 * Alias discovery — the abbreviations a memory defines in its own words.
 *
 * `entities` is unique on `(canonical_name, entity_type)`, so `Power Query`,
 * `PQ` and `power query` are three nodes unless something says they are one
 * thing. Nothing did: `canonicalizeEntityName` only folds case and spacing, and
 * the retrieval expansion joins `memory_links` on the exact string, so a memory
 * that wrote the abbreviation was unreachable from a query that used the full
 * name — the graph grew a second, thinner leg instead of merging.
 *
 * Only *explicit* definitions count. Asking a model which names are the same
 * thing is the obvious alternative and the wrong one: a wrong merge is
 * unrecoverable in the graph (both nodes' edges get attributed to one entity,
 * and nothing later disagrees), while a missed abbreviation just leaves the
 * pre-existing duplicate. So the forms are the ones a writer uses deliberately:
 *
 *   Power Query（PQ）      PQ（Power Query）      Power Query(PQ)
 *   Termux 又称 TX        简称 PQ                 也就是 PQ
 *   PQ 是 Power Query 的简称                     aka PQ
 *
 * Everything else is left alone, including the tempting "one name is a prefix of
 * the other" heuristic — `Termux` and `Termux App` may genuinely be a tool and a
 * fork of it, and the corpus is where that distinction lives.
 *
 * The parsing is deliberately not one big regex: a name can be one CJK word
 * (`飞书`) or several Latin words (`Power Query`), and it can sit flush against a
 * Chinese sentence (`都用Power Query（PQ）`). So a bracket is found first, and the
 * candidate names are the suffixes of the text before it that start at a plausible
 * boundary — then the ordinary name/token gates decide.
 */

import { isTokenAlignedMention, isVouchableEntityName } from './entity-mining.js';

const MIN_ALIAS_LENGTH = 2;
const MAX_ALIAS_LENGTH = 40;
/** How far before a bracket an alias definition can start. */
const LOOKBEHIND = 60;

const BRACKET_PAIR = /[（(]\s*([^（）()]{1,60}?)\s*[）)]/g;
/** The words a writer uses to introduce an abbreviation. */
const INTRODUCED = /(?:又称|又叫|简称|缩写为|也就是|aka|a\.k\.a\.)/i;
/** `PQ 是 Power Query 的简称` */
const DEFINED_BY = /^([^\s，。；、,:;]{1,20})\s*是\s*(.+?)\s*的?\s*(?:简称|缩写)/;

function acceptableAlias(candidate: string, name: string, text: string): boolean {
  const alias = candidate.trim();
  if (alias.length < MIN_ALIAS_LENGTH || alias.length > MAX_ALIAS_LENGTH) return false;
  if (alias.toLowerCase() === name.trim().toLowerCase()) return false;
  if (!isVouchableEntityName(alias)) return false;
  // The alias has to be written in this memory, as a unit: a substring sliced out
  // of a longer word is not an abbreviation of anything.
  return isTokenAlignedMention(text, alias);
}

/**
 * Every suffix of `prefix` that could be a name, longest first.
 *
 * Longest first matters: `Power Query` is the answer, not `Query`. A suffix is
 * only a candidate when it starts at a boundary — the beginning, after a space or
 * punctuation, or at a Latin/CJK transition — so `都用Power Query` offers
 * `Power Query` and `都用Power Query`, and the gates drop the second.
 */
function nameCandidates(prefix: string): string[] {
  const window = prefix.slice(-LOOKBEHIND);
  const starts: number[] = [0];
  for (let index = 1; index < window.length; index++) {
    const previous = window[index - 1];
    const current = window[index];
    const atBoundary = /[\s，。；、,:;（）()]/.test(previous);
    // CJK → Latin ("都用Power") and Latin → CJK ("Query完成") are name edges.
    const scriptChange =
      /[\u4e00-\u9fff\uff00-\uffef]/.test(previous) !==
      /[\u4e00-\u9fff\uff00-\uffef]/.test(current);
    if (atBoundary || scriptChange) starts.push(index);
  }
  return starts
    .map((start) => window.slice(start).trim())
    .filter((candidate) => candidate.length >= MIN_ALIAS_LENGTH)
    .sort((a, b) => b.length - a.length);
}

/** The trailing name-ish run after an introducer: `简称 PQ` → `PQ`. */
function introducedOperand(rest: string): string {
  return (rest.trimStart().match(/^[^\s，。；、,:;（）()]{1,40}/)?.[0] ?? '').trim();
}

/**
 * Aliases this memory states for `name`. Empty when it states none — the common
 * case, and the one that must stay cheap.
 */
export function discoverAliases(text: string, name: string): string[] {
  const target = name.trim();
  if (target === '' || text === '') return [];
  const targetKey = target.toLowerCase();
  const found = new Set<string>();

  const add = (candidate: string | undefined): void => {
    if (candidate && acceptableAlias(candidate, target, text)) found.add(candidate.trim());
  };

  // Bracketed definitions, both directions.
  for (const match of text.matchAll(BRACKET_PAIR)) {
    const inner = (match[1] ?? '').trim();
    if (inner === '') continue;
    const openIndex = match.index ?? 0;
    const prefix = text.slice(0, openIndex);
    const candidates = nameCandidates(prefix);
    const named = candidates.find((candidate) => candidate.toLowerCase() === targetKey);

    if (named) {
      // `X（inner）` and X is our name → inner is its abbreviation.
      add(inner);
      continue;
    }
    if (inner.toLowerCase() === targetKey) {
      // `inner（X）` and inner is our name → the prefix names the long form.
      add(candidates.find((candidate) => acceptableAlias(candidate, target, text)));
    }
  }

  // Introducers: `X 又称 Y`, `X 简称 Y`, `X aka Y`. One occurrence is enough — a
  // memory that defines abbreviations defines them once, and scanning every hit
  // would multiply the jieba alignments for no coverage.
  const introduced = INTRODUCED.exec(text);
  if (introduced) {
    const index = introduced.index;
    const operand = introducedOperand(text.slice(index + introduced[0].length));
    const candidates = nameCandidates(text.slice(0, index));
    if (candidates.some((candidate) => candidate.toLowerCase() === targetKey)) {
      add(operand);
    } else if (operand.toLowerCase() === targetKey) {
      add(candidates.find((candidate) => acceptableAlias(candidate, target, text)));
    }
  }

  // `PQ 是 Power Query 的简称`
  const defined = DEFINED_BY.exec(text);
  if (defined) {
    const short = (defined[1] ?? '').trim();
    const long = (defined[2] ?? '').trim();
    if (long.toLowerCase() === targetKey) add(short);
    else if (short.toLowerCase() === targetKey) add(long);
  }

  return [...found];
}
