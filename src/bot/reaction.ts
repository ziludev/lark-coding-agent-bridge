import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';

/** Feishu emoji_type for "敲键盘" — the conventional "I'm replying" cue. */
const WORKING_REACTION = 'Typing';
/** Feishu emoji_type for "搞定/已完成" — the run-finished cue. */
const DONE_REACTION = 'DONE';
/** Feishu emoji_type for a run that ended without an answer (error / timeout). */
const FAILED_REACTION = 'ERROR';

/**
 * Add a "Typing" reaction (敲键盘) to a message to give text-mode users an
 * instant "I got your message and I'm responding" cue while Claude is still
 * thinking. Matches the conventional Feishu UX for "the other side is
 * replying". Card mode doesn't need this — the streaming card already
 * shows a "正在思考…" footer the moment it's posted.
 *
 * Returns the reaction id on success, undefined on any failure. Failures
 * are logged but never thrown — losing a decoration must not break the
 * actual reply flow.
 */
export async function addWorkingReaction(
  channel: LarkChannel,
  messageId: string,
): Promise<string | undefined> {
  return addReaction(channel, messageId, WORKING_REACTION);
}

/**
 * Mark the run finished on the triggering message: the "Typing" reaction gives
 * way to `DONE`.
 *
 * This replaced a separate "✅ 已完成 · 1m23s" message. A run whose answer is
 * PATCHed into the streamed reply moves nothing in the chat, so the extra
 * message was the only signal — and a noisy one. The reaction sits exactly
 * where the typing cue was, so "still working" and "done" share one spot.
 */
export async function addDoneReaction(
  channel: LarkChannel,
  messageId: string,
): Promise<string | undefined> {
  return addReaction(channel, messageId, DONE_REACTION);
}

/** Same cue for a run that ended without an answer (error / idle timeout). */
export async function addFailedReaction(
  channel: LarkChannel,
  messageId: string,
): Promise<string | undefined> {
  return addReaction(channel, messageId, FAILED_REACTION);
}

/** Remove a previously-added reaction. Tolerates errors silently — best
 * effort cleanup; a leftover reaction is harmless. */
export async function removeReaction(
  channel: LarkChannel,
  messageId: string,
  reactionId: string,
): Promise<void> {
  try {
    await channel.removeReaction(messageId, reactionId);
    log.info('reaction', 'removed', { messageId, reactionId });
  } catch (err) {
    log.warn('reaction', 'remove-failed', {
      messageId,
      reactionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function addReaction(
  channel: LarkChannel,
  messageId: string,
  emojiType: string,
): Promise<string | undefined> {
  try {
    const id = await channel.addReaction(messageId, emojiType);
    if (id) log.info('reaction', 'added', { messageId, emojiType, reactionId: id });
    return id;
  } catch (err) {
    log.warn('reaction', 'add-failed', {
      messageId,
      emojiType,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
