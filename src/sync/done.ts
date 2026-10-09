/**
 * How a crossed-off (`done`) event looks on a synced calendar: its title
 * with a check mark in front, "✓ Assignment 2". Phones show it at a glance,
 * and ticking an event off there -- typing the mark -- comes back as done.
 *
 * The mark lives only on the server copy. Notes keep the plain title and a
 * `done: true` line; every writer adds the mark and every reader strips it,
 * so comparisons always run on plain titles and an unchanged event still
 * patches to a no-op.
 */

export const DONE_MARK = "✓";

/** The title a service should show. */
export function markTitle(title: string, done: boolean | undefined): string {
	const plain = readTitle(title).title;
	return done ? `${DONE_MARK} ${plain}` : plain;
}

/**
 * Splits a server title into the plain title and whether it carries the
 * mark. A mark needs a space after it, so "✓" alone or "✓done" is a title,
 * not a checked-off event. Also accepts the heavier ✔ a phone keyboard may
 * offer.
 */
export function readTitle(raw: string | undefined): { title: string; done: boolean } {
	const value = raw ?? "";
	const match = value.match(/^\s*[✓✔]️?\s+(\S[\s\S]*)$/);
	if (!match) return { title: value, done: false };
	return { title: match[1], done: true };
}
