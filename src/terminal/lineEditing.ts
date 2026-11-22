export interface LineState {
  line: string;
  cursor: number;
}

/**
 * Ctrl+W (bash's unix-word-rubout): delete from the cursor back to the start of the
 * previous whitespace-delimited word, including whitespace between them.
 */
export function deleteWordBackward({ line, cursor }: LineState): LineState {
  let start = cursor;
  while (start > 0 && /\s/.test(line[start - 1]!)) start--;
  while (start > 0 && !/\s/.test(line[start - 1]!)) start--;
  return { line: line.slice(0, start) + line.slice(cursor), cursor: start };
}
