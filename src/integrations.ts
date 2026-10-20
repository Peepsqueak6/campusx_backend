// Hooks into modules owned by other people. Replace the bodies when Module B's cache code exists.
// Each is called AFTER the database change has committed, so a failure here never undoes moderation.

/** Remove one post from the Redis feed cache. Called when moderation removes or holds a post. */
export async function purgePostFromFeedCache(_postId: string): Promise<void> {
  // TODO(Module B): delete the post id from cached timelines.
}

/** Remove every post by an author from feed caches. Called on Tier 2 deactivation and on reversal. */
export async function purgeAuthorFromFeedCache(_authorId: string): Promise<void> {
  // TODO(Module B): invalidate cached timelines containing this author.
}
