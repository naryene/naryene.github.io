import { assert, assertEquals, assertStringIncludes } from "std/assert/mod.ts";

import { parse, render } from "./djot.ts";

function render_dj(source: string): string {
  return render(parse(source), {}).value;
}

function code_lines(html: string): string[] {
  return [...html.matchAll(/<span class="line[^"]*">/g)].map((it) => it[0]);
}

Deno.test("known language gets a label and highlight.js classes", () => {
  const html = render_dj("```rust\nfn main() {}\n```\n");

  assertStringIncludes(html, '<span class="code-language">rust</span>');
  assertStringIncludes(html, '<span class="hl-keyword">fn</span>');
  assertStringIncludes(html, '<figure class="code-block">');
});

Deno.test("registered non-default language keeps highlighting", () => {
  const html = render_dj("```zig\nconst x = 1;\n```\n");

  assertStringIncludes(html, '<span class="code-language">zig</span>');
  assertStringIncludes(html, '<span class="hl-keyword">const</span>');
});

Deno.test("unknown language falls back to escaped plain text", () => {
  const html = render_dj(
    "```bogus-lang\n<script>alert(\"x\" & 'y')</script>\n```\n",
  );

  assertStringIncludes(html, '<span class="code-language">bogus-lang</span>');
  assertStringIncludes(
    html,
    "&lt;script&gt;alert(\"x\" &amp; 'y')&lt;/script&gt;",
  );
  assert(!html.includes("<script"), "raw script tag leaked into output");
  assert(!html.includes("hl-"), "unknown language must not be highlighted");
  assertEquals(code_lines(html).length, 1);
});

Deno.test("language identifier itself is escaped, not injected", () => {
  const html = render_dj('```<script>alert("x")</script>\ncode\n```\n');

  assertStringIncludes(
    html,
    '<span class="code-language">&lt;script&gt;alert("x")&lt;/script&gt;</span>',
  );
  assert(!html.includes("<script"), "raw script tag leaked into output");
});

Deno.test("missing language renders the text label and escaped source", () => {
  const html = render_dj('```\na < b && c > d "q"\n```\n');

  assertStringIncludes(html, '<span class="code-language">text</span>');
  assertStringIncludes(html, 'a &lt; b &amp;&amp; c &gt; d "q"');
  assert(!html.includes("hl-"), "unlabelled block must not be highlighted");
});

Deno.test("adoc blocks stay plain but keep their label", () => {
  const html = render_dj("```adoc\n= Title <x>\n```\n");

  assertStringIncludes(html, '<span class="code-language">adoc</span>');
  assertStringIncludes(html, "= Title &lt;x&gt;");
  assert(!html.includes("hl-"), "adoc block must not be highlighted");
});

Deno.test("console blocks keep prompt and output classes", () => {
  const html = render_dj(
    "```console\n$ deno task build\n# a comment\nsome output\n```\n",
  );

  assertStringIncludes(html, '<span class="code-language">console</span>');
  assertStringIncludes(html, '<span class="hl-title function_">$</span>');
  assertStringIncludes(html, '<span class="hl-comment"># a comment</span>');
  assertStringIncludes(html, '<span class="hl-output">some output</span>');
});

Deno.test("every source line gets a line wrapper, blank lines included", () => {
  const html = render_dj("```rust\nlet a = 1;\n\nlet b = 2;\n```\n");

  assertEquals(code_lines(html).length, 3);
  assertStringIncludes(html, '<span class="line"></span>');
});

Deno.test("multiline nested spans are closed and reopened per line", () => {
  const html = render_dj('```rust\nlet s = "one\ntwo";\n```\n');

  assertEquals(code_lines(html).length, 2);
  const lines = html.split("\n").filter((it) => it.includes('class="line'));
  for (const line of lines) {
    const open = (line.match(/<span/g) ?? []).length;
    const close = (line.match(/<\/span>/g) ?? []).length;
    assertEquals(open, close, `unbalanced spans in: ${line}`);
  }
});

Deno.test("highlight spec marks the selected lines", () => {
  const html = render_dj(
    '{highlight="2-3"}\n```rust\nlet a = 1;\nlet b = 2;\nlet c = 3;\nlet d = 4;\n```\n',
  );

  assertEquals(code_lines(html), [
    '<span class="line">',
    '<span class="line hl-line">',
    '<span class="line hl-line">',
    '<span class="line">',
  ]);
});

Deno.test("callouts are extracted from the source", () => {
  const html = render_dj(
    "```rust\nlet a = 1; // <1> <2>\nlet b = 2;\n<3>\n```\n",
  );

  assertStringIncludes(html, '<i class="callout" data-value="1"></i>');
  assertStringIncludes(html, '<i class="callout" data-value="2"></i>');
  assertStringIncludes(html, '<i class="callout" data-value="3"></i>');
  assert(!html.includes("&lt;1&gt;"), "callout marker left in the source");
  assertEquals(code_lines(html).length, 3);
});

Deno.test("callout-like tokens inside code remain untouched", () => {
  const html = render_dj(
    '```unknown\nauto b = f<1>();\nx = "<2>";\necho a<3>b\n```\n',
  );

  assertStringIncludes(html, "f&lt;1&gt;();");
  assertStringIncludes(html, '"&lt;2&gt;"');
  assertStringIncludes(html, "a&lt;3&gt;b");
  assert(!html.includes('class="callout"'));
});

Deno.test("caption and language share one escaped header", () => {
  const html = render_dj(
    '{cap="A & B <script>alert(1)</script> \\"q\\""}\n```rust\nfn main() {}\n```\n',
  );

  assertStringIncludes(
    html,
    '<figcaption class="code-block-header"><span class="code-title">A &amp; B &lt;script&gt;alert(1)&lt;/script&gt; "q"</span><span class="code-language">rust</span></figcaption>',
  );
  assertEquals((html.match(/<figcaption/g) ?? []).length, 1);
  assert(!html.includes("<script"), "raw script tag leaked into output");
});

Deno.test("header is present without a caption", () => {
  const html = render_dj("```rust\nfn main() {}\n```\n");

  assertStringIncludes(
    html,
    '<figcaption class="code-block-header"><span class="code-language">rust</span></figcaption>',
  );
  assert(!html.includes("code-title"), "unexpected empty caption element");
});

Deno.test("no runtime highlighting is emitted", () => {
  const html = render_dj(
    "```python\ndef f():\n    return 1\n```\n\n```\nplain\n```\n",
  );

  assert(!html.includes("<script"), "code blocks must not ship javascript");
  assert(!html.includes("onclick"), "code blocks must not ship javascript");
  assert(!html.includes("http"), "code blocks must not fetch anything");
});

Deno.test("trailing newlines do not add an empty line wrapper", () => {
  const html = render_dj("```rust\nlet a = 1;\n\n\n```\n");

  assertEquals(code_lines(html).length, 1);
});
