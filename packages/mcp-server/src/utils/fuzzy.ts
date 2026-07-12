import { ToolError } from '../error.js';

/**
 * Line-based fuzzy matching for edit_file. When an exact substring match is not
 * found, we compare blocks of lines with leading/trailing whitespace trimmed so
 * minor indentation differences still match.
 */

/**
 * Return the start-line indices of every block in `content` whose trimmed lines
 * equal the trimmed lines of `oldString`.
 */
export function findBlockMatches(content: string, oldString: string): number[] {
  const contentLines = content.split('\n');
  const targetLines = oldString.split('\n');
  const matches: number[] = [];
  if (targetLines.length === 0) return matches;

  const lastStart = contentLines.length - targetLines.length;
  for (let i = 0; i <= lastStart; i++) {
    let ok = true;
    for (let j = 0; j < targetLines.length; j++) {
      if (contentLines[i + j].trim() !== targetLines[j].trim()) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push(i);
  }
  return matches;
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

export interface ReplaceResult {
  content: string;
  replacements: number;
  fuzzy: boolean;
}

/**
 * Replace `oldString` with `newString` in `content`. Prefers an exact match;
 * falls back to line-based fuzzy matching. Throws INVALID_ARGUMENTS if there
 * are multiple matches and `replaceAll` is false, or if there is no match.
 */
export function replaceBlock(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): ReplaceResult {
  const exactCount = countOccurrences(content, oldString);

  if (exactCount > 0) {
    if (exactCount > 1 && !replaceAll) {
      throw new ToolError(
        'INVALID_ARGUMENTS',
        `Found ${exactCount} occurrences. Use replace_all=true or provide more context.`,
      );
    }
    if (replaceAll) {
      return { content: content.split(oldString).join(newString), replacements: exactCount, fuzzy: false };
    }
    return { content: content.replace(oldString, newString), replacements: 1, fuzzy: false };
  }

  // Fuzzy: match blocks of lines ignoring surrounding whitespace.
  const matches = findBlockMatches(content, oldString);
  if (matches.length === 0) {
    throw new ToolError(
      'INVALID_ARGUMENTS',
      'Could not find old_string in the file (exact or fuzzy match). Provide the exact text to replace.',
    );
  }
  if (matches.length > 1 && !replaceAll) {
    throw new ToolError(
      'INVALID_ARGUMENTS',
      `Found ${matches.length} occurrences. Use replace_all=true or provide more context.`,
    );
  }

  const contentLines = content.split('\n');
  const targetLen = oldString.split('\n').length;
  const newLines = newString.split('\n');
  // Replace from the last match backward so earlier indices stay valid.
  const targets = replaceAll ? [...matches].reverse() : [matches[0]];
  for (const start of targets) {
    contentLines.splice(start, targetLen, ...newLines);
  }
  return { content: contentLines.join('\n'), replacements: targets.length, fuzzy: true };
}
