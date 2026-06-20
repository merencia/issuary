/**
 * Parser for explicit issue/PR cross-references found in issue bodies and
 * comments. This is deliberately literal: it recognizes only the textual forms
 * GitHub itself links (`#123`, `owner/repo#123`, and `GH-123`-style numeric
 * references), never semantic or similarity-based relationships. Anything beyond
 * a literal token match is out of scope (see CLAUDE.md, princípio 7 / relacionamento).
 */

/**
 * Matches a cross-repo reference like `owner/repo#123`. Owner and repo follow
 * GitHub's allowed characters (alphanumerics, `-`, `_`, `.`). The leading `(?<![\w-])`
 * lookbehind keeps the owner from starting in the middle of another word so a URL
 * path segment such as `foo/bar/baz#1` does not match the wrong slice.
 */
const CROSS_REPO = /(?<![\w./-])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)/g;

/**
 * Matches a same-repo reference like `#123`. The leading lookbehind rejects a
 * `#` that is glued to a word character (e.g. an anchor in `page#section` or the
 * `repo#123` already handled by {@link CROSS_REPO}), so only standalone `#123`
 * tokens are captured.
 */
const SAME_REPO = /(?<![\w/#])#(\d+)/g;

/**
 * Matches an explicit `PR #123` / `pull request #123` / `pull/123` phrasing. The
 * issue/PR number is captured; the surrounding wording is normalized away to the
 * canonical `#123` form.
 */
const PR_PHRASE = /\b(?:pull request|pull|pr)\s*(?:#|\/)\s*(\d+)/gi;

/**
 * Strips fenced code blocks (```...```) and inline code spans (`...`) from the
 * text so references that are clearly shown as code (e.g. a literal `#123` in a
 * snippet) are not harvested. Autolink URLs are left intact: the regexes above
 * already avoid matching inside `owner/repo/...` URL paths via lookbehinds.
 */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
}

/**
 * Extracts the explicit issue/PR references from a text blob, returning a deduped
 * list of normalized literal targets in first-seen order.
 *
 * Recognized forms and their normalized output:
 * - `#123`            -> `"#123"`            (same-repo issue or PR)
 * - `owner/repo#123`  -> `"owner/repo#123"` (cross-repo)
 * - `PR #123`, `pull request #123`, `pull/123` -> `"#123"`
 *
 * References inside fenced or inline code are ignored. The issue's own number is
 * ignored when `selfNumber` is provided so an issue never references itself.
 *
 * @param text - The raw markdown body (or comment) to scan. `null`/empty yields `[]`.
 * @param selfNumber - The number of the issue being parsed, to drop self-references.
 * @returns Deduped, normalized literal targets in first-seen order.
 */
export function parseRefs(text: string | null | undefined, selfNumber?: number): string[] {
  if (!text) {
    return [];
  }

  const cleaned = stripCode(text);
  const seen = new Set<string>();
  const targets: string[] = [];

  const add = (target: string, number: number): void => {
    if (selfNumber !== undefined && number === selfNumber && !target.includes("/")) {
      // Self-reference: only drop the bare same-repo form; a cross-repo token
      // that happens to share the number still refers to a different repo.
      return;
    }
    if (!seen.has(target)) {
      seen.add(target);
      targets.push(target);
    }
  };

  for (const match of cleaned.matchAll(CROSS_REPO)) {
    add(`${match[1]}#${match[2]}`, Number(match[2]));
  }
  for (const match of cleaned.matchAll(PR_PHRASE)) {
    add(`#${match[1]}`, Number(match[1]));
  }
  for (const match of cleaned.matchAll(SAME_REPO)) {
    add(`#${match[1]}`, Number(match[1]));
  }

  return targets;
}
