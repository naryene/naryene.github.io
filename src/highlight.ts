import { html, HtmlString } from "./templates.ts";

import hljs_ from "highlightjs/highlight.min.js";
const hljs: any = hljs_;
hljs.configure({ classPrefix: "hl-" });

import latex from "highlightjs/languages/latex.min.js";
import nix from "highlightjs/languages/nix.min.js";
import x86asm from "highlightjs/languages/x86asm.min.js";
import zig from "./highlightjs-zig.js";

hljs.registerLanguage("latex", latex);
hljs.registerLanguage("nix", nix);
hljs.registerLanguage("x86asm", x86asm);
hljs.registerLanguage("Zig", zig);
hljs.registerLanguage("ungrammar", () => ({
  name: "ungrammar",
  contains: [
    {
      className: "string",
      begin: "\\'",
      end: "\\'",
    },
    {
      scope: "literal",
      match:"[A-Z][_a-zA-Z0-9]*(?= =)"
    }
  ],
}));

export type CodeBlockOptions = {
  source: string;
  language?: string;
  caption?: string;
  highlight_spec?: string;
};

export function code_block(options: CodeBlockOptions): HtmlString {
  const pre = highlight(options.source, options.language, options.highlight_spec);
  const title = options.caption
    ? html`<span class="code-title">${options.caption}</span>`
    : "";
  const header = html`<figcaption class="code-block-header">${title}<span class="code-language">${
    language_label(options.language)
  }</span></figcaption>`;
  return html`\n<figure class="code-block">\n${header}${pre}</figure>\n`;
}

export function language_label(language?: string): string {
  const label = language?.trim();
  return label ? label : "text";
}

export function highlight(
  source: string,
  language?: string,
  highlight_spec?: string,
): HtmlString {
  const spec = parse_highlight_spec(highlight_spec);
  let src = source;
  let callouts: Map<number, number[]>;
  [src, callouts] = parse_callouts(src);
  let highlighted: string = add_spans(src, language).value;
  highlighted = highlighted.trimEnd();
  const openTags: string[] = [];
  highlighted = highlighted.replace(
    /(<span [^>]+>)|(<\/span>)|(\n)/g,
    (match) => {
      if (match === "\n") {
        return "</span>".repeat(openTags.length) + "\n" + openTags.join("");
      }

      if (match === "</span>") {
        openTags.pop();
      } else {
        openTags.push(match);
      }

      return match;
    },
  );
  const highlighted_lines = highlighted.split("\n");
  const callout_lines = [...callouts.keys()];
  const last_callout_line = callout_lines.length > 0 ? Math.max(...callout_lines) : -1;
  while (highlighted_lines.length <= last_callout_line) highlighted_lines.push("");
  const lines = highlighted_lines.map((it, idx) => {
    const cls = spec.includes(idx + 1) ? ' hl-line' : '';
    const calls = (callouts.get(idx) ?? [])
      .map((it) => `<i class="callout" data-value="${it}"></i>`)
      .join(" ");
    return `<span class="line${cls}">${it}${calls}</span>`;
  })
    .join("\n");
  return html`\n<pre><code>${new HtmlString(lines)}</code></pre>\n`;
}

function add_spans(source: string, language?: string): HtmlString {
  if (!language || language === "adoc") return html`${source}`;
  if (language == "console") return add_spans_console(source);
  if (!hljs.getLanguage(language)) return html`${source}`;
  const res = hljs.highlight(source, { language, ignoreIllegals: true });
  return new HtmlString(res.value);
}

function add_spans_console(source: string): HtmlString {
  let cont = false;
  const lines = source.trimEnd().split("\n").map((line) => {
    if (cont) {
      cont = line.endsWith("\\");
      return html`${line}\n`;
    }
    if (line.startsWith("$ ")) {
      cont = line.endsWith("\\");
      return html`<span class="hl-title function_">$</span> ${
        line.substring(2)
      }\n`;
    }
    if (line.startsWith("#")) {
      return html`<span class="hl-comment">${line}</span>\n`;
    }
    return html`<span class="hl-output">${line}</span>\n`;
  });
  return html`${lines}`;
}

function parse_highlight_spec(spec?: string): number[] {
  if (!spec) return [];
  return spec.split(",").flatMap((el) => {
    if (el.includes("-")) {
      const [los, his] = el.split("-");
      const lo = parseInt(los, 10);
      const hi = parseInt(his, 10);
      return Array.from({ length: (hi - lo) + 1 }, (x, i) => lo + i);
    }
    return [parseInt(el, 10)];
  });
}

function parse_callouts(source: string): [string, Map<number, number[]>] {
  const res: Map<number, number[]> = new Map();
  const lines = source.split("\n").map((source_line, line) => {
    const callouts: number[] = [];
    let text = source_line;
    while (true) {
      const match = /[ \t]*<(\d)>[ \t]*$/.exec(text);
      if (!match) break;
      callouts.unshift(Number(match[1]));
      text = text.slice(0, match.index);
    }
    if (callouts.length > 0) res.set(line, callouts);
    return text;
  });
  return [lines.join("\n"), res];
}
