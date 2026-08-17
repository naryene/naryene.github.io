// Expands author facing `$...$` / `$$...$$` math into djot's native math syntax
// (a `$` or `$$` sigil directly followed by a verbatim span) before parsing.
//
// The scanner is deliberately not a regex substitution: it walks the source once
// and knows about the constructs whose bytes djot reads back verbatim, so they
// are copied through untouched. Two families matter.
//
// Block level, recognised after djot's container prefixes (`>` markers and list
// markers) so they are also found inside blockquotes and list items: fenced code
// and raw blocks, and link reference definitions.
//
// Inline: escapes, verbatim spans, autolinks, link destinations, reference
// labels and attributes. A formula may *contain* one of those -- the whole
// formula becomes a verbatim span, so nothing inside it is reinterpreted -- but
// a closing delimiter is never looked for inside one. That is what keeps a
// currency `$` in prose from pairing with a `$` in a later URL.

type Formula = { text: string; end: number };
type Line = { text: string; next: number };

// A line's container prefix. `content` is the offset of the first character
// djot treats as block content, `list_indent` the column of the innermost list
// marker (djot keeps a list item open only while later lines are indented past
// it), and `quotes` the blockquote depth.
type Prefix = { quotes: number; list_indent: number; content: number };

export function expand_math(source: string): string {
  block_cache = undefined;
  const out: string[] = [];
  let pos = 0;
  while (pos < source.length) {
    if (pos === 0 || source[pos - 1] === "\n") {
      const block = scan_protected_block(source, pos);
      if (block !== undefined) {
        out.push(source.slice(pos, block));
        pos = block;
        continue;
      }
    }

    const special = next_special(source, pos);
    if (special > pos) {
      out.push(source.slice(pos, special));
      pos = special;
      if (pos === source.length) break;
    }

    const char = source[pos];
    if (char === "\n") {
      out.push(char);
      pos += 1;
      continue;
    }

    if (char !== "$") {
      const end = scan_protected_inline(source, pos);
      out.push(end === undefined ? char : source.slice(pos, end));
      pos = end === undefined ? pos + 1 : end;
      continue;
    }

    const dollars = run_length(source, pos, "$");
    const after = pos + dollars;
    if (source[after] === "`") {
      // Djot's native math: keep the sigil and its verbatim span as written.
      const end = scan_verbatim(source, after);
      out.push(source.slice(pos, end));
      pos = end;
      continue;
    }

    const math = dollars === 1
      ? scan_inline_math(source, after)
      : dollars === 2
      ? scan_display_math(source, after)
      : undefined;
    if (math) {
      out.push(emit_math(math.text, dollars === 1 ? 1 : 2));
      // Separate the generated closing fence from an adjacent verbatim opener.
      // Djot discards comment-only attributes, so this preserves both nodes
      // without adding visible output.
      if (source[math.end] === "`") out.push("{%%}");
      pos = math.end;
      continue;
    }

    out.push(source.slice(pos, after));
    pos = after;
  }
  return out.join("");
}

const not_special = /[^\n\\`$<{\]]*/y;

function next_special(source: string, from: number): number {
  not_special.lastIndex = from;
  const match = not_special.exec(source);
  return match ? from + match[0].length : from;
}

// Block level constructs whose whole extent djot reads as source text.
function scan_protected_block(source: string, start: number): number | undefined {
  return scan_fenced_block(source, start) ?? scan_reference_definition(source, start);
}

// Inline constructs that must survive byte for byte. Returns the end of the
// construct, or undefined when the character does not start one.
function scan_protected_inline(source: string, pos: number): number | undefined {
  switch (source[pos]) {
    case "\\":
      return Math.min(pos + 2, source.length);
    case "`":
      return scan_raw_inline(source, pos);
    case "<":
      return scan_autolink(source, pos);
    case "{":
      return scan_attributes(source, pos);
    case "]":
      return scan_link_tail(source, pos);
    default:
      return undefined;
  }
}

// The subset a formula skips over. Backtick runs are left out: a formula is
// allowed to contain them (`emit_math` picks a longer fence), and only a run
// that actually closes is a verbatim span djot would read back.
function scan_protected_in_formula(source: string, pos: number): number | undefined {
  switch (source[pos]) {
    case "\\":
      return Math.min(pos + 2, source.length);
    case "`":
      return close_verbatim(source, pos);
    case "<":
      return scan_autolink(source, pos);
    case "{":
      return scan_attributes(source, pos);
    case "]":
      return scan_link_tail(source, pos);
    default:
      return undefined;
  }
}

// Mirrors djot's code fence: three or more backticks or tildes, an optional info
// word without backticks, nothing else on the line. The fence is looked for
// after the container prefix, so `> ~~~`, `- ~~~` and `> - ~~~` open one too.
const fence_open = /^(`{3,}|~{3,})[ \t]*[^ \t`]*[ \t]*$/;

function scan_fenced_block(source: string, start: number): number | undefined {
  const opening = read_line(source, start);
  const prefix = scan_container_prefix(opening.text);
  const match = fence_open.exec(opening.text.slice(prefix.content));
  if (!match) return undefined;

  const fence = match[1];
  const fence_close = new RegExp(`^${fence[0]}{${fence.length},}[ \\t]*$`);
  let pos = opening.next;
  while (pos < source.length) {
    const line = read_line(source, pos);
    const cont = continue_prefix(line.text, prefix);
    if (cont === undefined) return pos;
    pos = line.next;
    if (cont.blank) continue;
    if (fence_close.test(line.text.slice(cont.content))) return pos;
  }
  return source.length;
}

// `[label]: destination`, whose destination is a URL djot never re-parses. A
// leading `^` makes it a footnote instead, which does hold djot content.
const reference_definition = /^\[(?!\^)[^\]\r\n]*\]:/;

function scan_reference_definition(source: string, start: number): number | undefined {
  const opening = read_line(source, start);
  const prefix = scan_container_prefix(opening.text);
  if (!reference_definition.test(opening.text.slice(prefix.content))) return undefined;

  let pos = opening.next;
  while (pos < source.length) {
    // A definition continues on lines indented past it that hold a single
    // unbroken destination fragment.
    const line = read_line(source, pos);
    const cont = continue_prefix(line.text, prefix);
    if (cont === undefined || cont.blank || cont.content <= prefix.content) return pos;
    if (!/^\S+$/.test(line.text.slice(cont.content))) return pos;
    pos = line.next;
  }
  return pos;
}

const list_marker =
  /(?::?[-*+:]|\((?:[0-9]+|[ivxlcdmIVXLCDM]+|[a-zA-Z])\)|(?:[0-9]+|[ivxlcdmIVXLCDM]+|[a-zA-Z])[.)])(?=[ \t]|$)/y;

function scan_container_prefix(text: string): Prefix {
  let pos = 0;
  let quotes = 0;
  let list_indent = -1;
  for (;;) {
    while (is_blank(text[pos])) pos += 1;
    if (is_quote_marker(text, pos)) {
      quotes += 1;
      pos += 1;
      continue;
    }
    list_marker.lastIndex = pos;
    const marker = list_marker.exec(text);
    if (marker) {
      list_indent = pos;
      pos += marker[0].length;
      continue;
    }
    break;
  }
  return { quotes, list_indent, content: pos };
}

// Whether a later line still sits inside the containers of `prefix`, and where
// its own content starts. Undefined once a container has closed.
function continue_prefix(
  text: string,
  prefix: Prefix,
): { content: number; blank: boolean } | undefined {
  let pos = 0;
  let quotes = 0;
  while (quotes < prefix.quotes) {
    while (is_blank(text[pos])) pos += 1;
    if (!is_quote_marker(text, pos)) break;
    quotes += 1;
    pos += 1;
  }
  while (is_blank(text[pos])) pos += 1;
  if (quotes < prefix.quotes) return undefined;
  if (pos === text.length) return { content: pos, blank: true };
  if (pos <= prefix.list_indent) return undefined;
  return { content: pos, blank: false };
}

// Djot only takes `>` as a blockquote marker when whitespace or a line end
// follows it.
function is_quote_marker(text: string, pos: number): boolean {
  return text[pos] === ">" && (pos + 1 === text.length || is_blank(text[pos + 1]));
}

function read_line(source: string, start: number): Line {
  const newline = source.indexOf("\n", start);
  const end = newline === -1 ? source.length : newline;
  const text = end > start && source.charAt(end - 1) === "\r"
    ? source.slice(start, end - 1)
    : source.slice(start, end);
  return { text, next: newline === -1 ? source.length : newline + 1 };
}

// A verbatim span, plus the `{=format}` suffix that turns it into raw inline.
function scan_raw_inline(source: string, start: number): number {
  const end = scan_verbatim(source, start);
  raw_format.lastIndex = end;
  const match = raw_format.exec(source);
  return match ? end + match[0].length : end;
}

const raw_format = /\{=[^\s{}]*\}/y;

// A verbatim span is closed by a backtick run of exactly the same length and,
// like every djot inline, cannot escape its own block.
function scan_verbatim(source: string, start: number): number {
  return close_verbatim(source, start) ?? block_end(source, start);
}

function close_verbatim(source: string, start: number): number | undefined {
  const open = run_length(source, start, "`");
  const limit = block_end(source, start);
  let pos = start + open;
  while (pos < limit) {
    if (source[pos] === "`") {
      const run = run_length(source, pos, "`");
      if (run === open) return pos + run;
      pos += run;
    } else {
      pos += 1;
    }
  }
  return undefined;
}

// `<https://example.com>`: no whitespace or angle brackets inside, and djot only
// links it when it looks like a URL or an email address.
const autolink = /<([^<>\s]+)>/y;

function scan_autolink(source: string, start: number): number | undefined {
  autolink.lastIndex = start;
  const match = autolink.exec(source);
  if (!match) return undefined;
  const url = match[1];
  if (!/[^:]@/.test(url) && !/[a-zA-Z]:/.test(url)) return undefined;
  return start + match[0].length;
}

// What follows the `]` of a link: an inline destination or a reference label.
function scan_link_tail(source: string, start: number): number | undefined {
  if (source[start + 1] === "(") return scan_destination(source, start + 2);
  if (source[start + 1] === "[") return scan_reference_label(source, start + 2);
  return undefined;
}

function scan_destination(source: string, from: number): number | undefined {
  const limit = block_end(source, from);
  let depth = 1;
  let pos = from;
  while (pos < limit) {
    const char = source[pos];
    if (char === "\\") {
      pos += 2;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return pos + 1;
    }
    pos += 1;
  }
  return undefined;
}

function scan_reference_label(source: string, from: number): number | undefined {
  const limit = block_end(source, from);
  let pos = from;
  while (pos < limit) {
    const char = source[pos];
    if (char === "\\") {
      pos += 2;
      continue;
    }
    if (char === "[") return undefined;
    if (char === "]") return pos + 1;
    pos += 1;
  }
  return undefined;
}

// Djot's attribute grammar (`attributes.ts`): `{`, then `#id`, `.class`,
// `key=value` with a bare or quoted value, and `%comment%` separated by
// whitespace, then `}`. Braces that do not parse are ordinary prose and are left
// alone, so `$x_{i=1}$` and `$\mathbb{R}$` keep working.
function scan_attributes(source: string, start: number): number | undefined {
  const limit = block_end(source, start);
  let pos = start + 1;
  for (;;) {
    while (pos < limit && is_space(source[pos])) pos += 1;
    if (pos >= limit) return undefined;
    if (source[pos] === "}") return pos + 1;
    const end = scan_attribute(source, pos, limit);
    if (end === undefined) return undefined;
    if (end < limit && !is_space(source[end]) && source[end] !== "}") return undefined;
    pos = end;
  }
}

function scan_attribute(source: string, start: number, limit: number): number | undefined {
  const char = source[start];
  if (char === "%") {
    const end = source.indexOf("%", start + 1);
    return end === -1 || end >= limit ? undefined : end + 1;
  }
  if (char === "#" || char === ".") {
    let pos = start + 1;
    while (pos < limit && is_name_char(source[pos])) pos += 1;
    return pos > start + 1 ? pos : undefined;
  }
  if (!is_key_char(char)) return undefined;

  let pos = start;
  while (pos < limit && is_key_char(source[pos])) pos += 1;
  if (source[pos] !== "=" || pos >= limit) return undefined;
  pos += 1;
  if (source[pos] === '"') {
    pos += 1;
    while (pos < limit) {
      if (source[pos] === "\\") {
        pos += 2;
        continue;
      }
      if (source[pos] === '"') return pos + 1;
      pos += 1;
    }
    return undefined;
  }
  const value = pos;
  while (pos < limit && is_key_char(source[pos])) pos += 1;
  return pos > value ? pos : undefined;
}

// Index of the newline that starts the blank line ending the current block. A
// line holding nothing but blockquote markers is blank for djot too.
//
// Every protected construct asks for the end of its block, so the answer is
// memoised: once a block is known to run from `from` to `end`, every position
// inside it has the same answer, and the scanner only ever moves forward.
let block_cache: { source: string; from: number; end: number } | undefined;

function block_end(source: string, from: number): number {
  const cached = block_cache;
  if (cached && cached.source === source && from >= cached.from && from <= cached.end) {
    return cached.end;
  }
  const end = find_block_end(source, from);
  block_cache = { source, from, end };
  return end;
}

function find_block_end(source: string, from: number): number {
  let pos = from;
  while (pos < source.length) {
    const newline = source.indexOf("\n", pos);
    if (newline === -1) return source.length;
    if (is_blank_line(read_line(source, newline + 1).text)) return newline;
    pos = newline + 1;
  }
  return source.length;
}

function is_blank_line(text: string): boolean {
  let pos = 0;
  for (;;) {
    while (is_blank(text[pos])) pos += 1;
    if (!is_quote_marker(text, pos)) return pos === text.length;
    pos += 1;
  }
}

// `$x^2$`: the opener may not be followed by whitespace, the closer may not be
// preceded by whitespace nor followed by a digit, and neither may cross a line.
// The first candidate closer that fails those rules ends the search, so prose
// like "it costs $5 and $6" stays literal instead of pairing across words.
function scan_inline_math(source: string, from: number): Formula | undefined {
  if (from === source.length || is_space(source[from])) return undefined;
  let pos = from;
  while (pos < source.length) {
    const char = source[pos];
    if (char === "\n") return undefined;
    if (char === "$") {
      if (run_length(source, pos, "$") !== 1) return undefined;
      if (is_space(source[pos - 1])) return undefined;
      if (is_digit(source[pos + 1])) return undefined;
      return { text: source.slice(from, pos), end: pos + 1 };
    }
    pos = skip_protected(source, pos);
  }
  return undefined;
}

// `$$...$$` may span lines, but not the blank line that would end the block the
// generated verbatim span lives in. The formula keeps the newlines and container
// prefixes of the source: djot strips those when it parses the block, and the
// leftover whitespace is trimmed off the parsed math node.
function scan_display_math(source: string, from: number): Formula | undefined {
  const limit = block_end(source, from);
  let pos = from;
  while (pos < limit) {
    if (source[pos] === "$") {
      const run = run_length(source, pos, "$");
      if (run >= 2) {
        const text = source.slice(from, pos);
        return text.trim().length === 0 ? undefined : { text, end: pos + 2 };
      }
      pos += run;
      continue;
    }
    pos = skip_protected(source, pos);
  }
  return undefined;
}

function skip_protected(source: string, pos: number): number {
  const end = scan_protected_in_formula(source, pos);
  return end !== undefined && end > pos ? end : pos + 1;
}

// The verbatim fence must be longer than every backtick run in the formula, and
// a formula touching a backtick needs the padding space djot strips back off.
function emit_math(text: string, dollars: 1 | 2): string {
  const fence = "`".repeat(longest_backtick_run(text) + 1);
  const pad_start = text.startsWith("`") ? " " : "";
  const pad_end = text.endsWith("`") ? " " : "";
  return `${"$".repeat(dollars)}${fence}${pad_start}${text}${pad_end}${fence}`;
}

function longest_backtick_run(text: string): number {
  let longest = 0;
  let pos = 0;
  while (pos < text.length) {
    if (text[pos] === "`") {
      const run = run_length(text, pos, "`");
      if (run > longest) longest = run;
      pos += run;
    } else {
      pos += 1;
    }
  }
  return longest;
}

function run_length(source: string, start: number, char: string): number {
  let end = start;
  while (end < source.length && source[end] === char) end += 1;
  return end - start;
}

function is_space(char: string | undefined): boolean {
  return char === undefined || char === " " || char === "\t" || char === "\n" || char === "\r";
}

function is_blank(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\r";
}

function is_digit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

function is_name_char(char: string): boolean {
  return /[\w:-]/.test(char);
}

function is_key_char(char: string): boolean {
  return /[a-zA-Z0-9_:-]/.test(char);
}
