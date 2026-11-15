import { AppError } from './errors.js';
import { repo } from './db/index.js';

// Post lifecycle. Every status change goes through transition(), which only allows the moves listed here and is
// atomic in the database (the update applies only if the post is still in the expected status).
//
//   draft ──approve──▶ approved ──claim──▶ publishing ──▶ published
//     ▲                  │  ▲                │  │
//     │                  │  └─safe retry─────┘  ├──▶ failed  (definitely not published; may be retried by a person)
//     └──unapprove───────┘                      └──▶ uncertain (the platform may or may not have published it)
//   failed ──▶ draft | approved | publishing     uncertain ──▶ published | failed  (only via reconciliation or a person)
//
// "uncertain" is never retried automatically: that is how duplicate posts happen.

export const STATUSES = ['draft', 'approved', 'publishing', 'published', 'failed', 'uncertain'];

export const TRANSITIONS = {
  draft: ['approved'],
  approved: ['draft', 'publishing', 'failed'],
  publishing: ['published', 'failed', 'uncertain', 'approved'],
  failed: ['draft', 'approved', 'publishing'],
  uncertain: ['published', 'failed'],
  published: [],
};

export const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new AppError('INVALID_TRANSITION', `A ${from} post cannot become ${to}.`, { status: 409 });
}

/**
 * Moves a post from one of `from` to `to`, applying `fields` in the same atomic update.
 * Returns the updated post, or null when the post was not in any of the `from` statuses (someone else moved it first).
 */
export async function transition(id, from, to, fields = {}) {
  const sources = Array.isArray(from) ? from : [from];
  for (const s of sources) assertTransition(s, to);
  return repo.updatePost(id, { ...fields, status: to }, { onlyIfStatus: sources });
}
