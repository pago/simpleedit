import type { PrReviewCommentSource } from '../../../shared/screenprs'

/** The chip colour for where a draft comment came from, shared by the composer list and the diff. */
export const SOURCE_CLASS: Record<PrReviewCommentSource, string> = {
  triage: 'bg-orange-500/15 text-orange-300',
  deep: 'bg-blue-500/15 text-blue-300',
  overview: 'bg-teal-500/15 text-teal-300',
  agent: 'bg-violet-500/18 text-violet-300',
  you: 'bg-zinc-700 text-zinc-200',
}
