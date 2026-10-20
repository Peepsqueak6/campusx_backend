import { BannedTerm } from '../models/index.js';
import { addToQueue } from './moderationQueue.js';
import { Post } from '../models/index.js';
import { purgePostFromFeedCache } from '../integrations.js';
import type { IdLike } from '../util/helpers.js';

const CACHE_MS = 60_000;

interface CompiledTerm {
  term: string;
  tenantDomain: string | null;
  regex: RegExp;
}

let cache: { loadedAt: number; terms: CompiledTerm[] } | null = null;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Builds the matcher for one term. Returns null when a REGEX term does not compile. */
export function compileTerm(term: string, matchType: 'WORD' | 'REGEX'): RegExp | null {
  try {
    if (matchType === 'WORD') {
      // Whole-word match, case-insensitive, Unicode-aware so "ass" does not match "class".
      return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(term)}(?![\\p{L}\\p{N}_])`, 'iu');
    }
    return new RegExp(term, 'iu');
  } catch {
    return null;
  }
}

/** Call after adding or removing a term so the change applies immediately on this instance. */
export function invalidateTermCache(): void {
  cache = null;
}

async function loadTerms(): Promise<CompiledTerm[]> {
  if (cache && Date.now() - cache.loadedAt < CACHE_MS) return cache.terms;
  const rows = await BannedTerm.find({ active: true }).lean();
  const terms: CompiledTerm[] = [];
  for (const row of rows) {
    const regex = compileTerm(row.term, row.matchType as 'WORD' | 'REGEX');
    if (regex) terms.push({ term: row.term, tenantDomain: row.tenantDomain ?? null, regex });
  }
  cache = { loadedAt: Date.now(), terms };
  return terms;
}

/**
 * Module B calls this when creating a post.
 * When `ok` is false the post must be saved as PENDING_REVIEW and `holdPostForReview` called.
 */
export async function checkContent(
  text: string,
  tenantDomain: string,
): Promise<{ ok: boolean; matchedTerms: string[] }> {
  const terms = await loadTerms();
  const matchedTerms = terms
    .filter((t) => t.tenantDomain === null || t.tenantDomain === tenantDomain)
    .filter((t) => t.regex.test(text))
    .map((t) => t.term);
  return { ok: matchedTerms.length === 0, matchedTerms };
}

/** Hides a post that the filter caught and puts it in the moderator queue. */
export async function holdPostForReview(args: {
  postId: IdLike;
  authorId: IdLike;
  tenantDomain: string;
  matchedTerms: string[];
}): Promise<void> {
  await Post.updateOne({ _id: args.postId }, { $set: { moderationStatus: 'PENDING_REVIEW' } });
  await addToQueue({
    targetType: 'POST',
    targetPostId: args.postId,
    targetUserId: args.authorId,
    tenantDomain: args.tenantDomain,
    source: 'PROFANITY_FILTER',
    matchedTerms: args.matchedTerms,
  });
  await purgePostFromFeedCache(String(args.postId));
}
