import { assert, assertEquals, assertStringIncludes, assertThrows } from "std/assert/mod.ts";

import { parse, render } from "./djot.ts";
import { expand_math } from "./math.ts";

type Node = {
  tag?: string;
  text?: string;
  destination?: string;
  attributes?: Record<string, string>;
  children?: Node[];
};

function nodes(source: string, tag: string): string[] {
  const found: string[] = [];
  const walk = (node: Node) => {
    if (node.tag === tag && typeof node.text === "string") found.push(node.text);
    for (const child of node.children ?? []) walk(child);
  };
  walk(parse(source) as unknown as Node);
  return found;
}

function destinations(source: string): string[] {
  const found: string[] = [];
  const walk = (node: Node) => {
    if (typeof node.destination === "string") found.push(node.destination);
    for (const child of node.children ?? []) walk(child);
  };
  walk(parse(source) as unknown as Node);
  return found;
}

function attribute(source: string, name: string): string[] {
  const found: string[] = [];
  const walk = (node: Node) => {
    const value = node.attributes?.[name];
    if (typeof value === "string") found.push(value);
    for (const child of node.children ?? []) walk(child);
  };
  walk(parse(source) as unknown as Node);
  return found;
}

function html(source: string): string {
  return render(parse(source), {}).value;
}

function assert_katex(rendered: string) {
  assertStringIncludes(rendered, 'class="katex"');
  assertStringIncludes(rendered, '<math xmlns="http://www.w3.org/1998/Math/MathML"');
  assertStringIncludes(rendered, 'encoding="application/x-tex"');
  assertStringIncludes(rendered, 'class="katex-html"');
  assert(!rendered.includes("\\("), "raw TeX delimiters leaked into the output");
  assert(!rendered.includes("\\["), "raw TeX delimiters leaked into the output");
}

Deno.test("inline $...$ becomes inline_math rendered by katex", () => {
  assertEquals(nodes("Euler: $e^{i\\pi} + 1 = 0$.", "inline_math"), ["e^{i\\pi} + 1 = 0"]);

  const rendered = html("Euler: $e^{i\\pi} + 1 = 0$.");
  assert_katex(rendered);
  assert(!rendered.includes("katex-display"), "inline math must not render in display mode");
  assertStringIncludes(rendered, "Euler:");
});

Deno.test("display $$...$$ becomes display_math rendered by katex", () => {
  assertEquals(nodes("$$\\sum_{i=1}^{n} i$$", "display_math"), ["\\sum_{i=1}^{n} i"]);

  const rendered = html("$$\\sum_{i=1}^{n} i$$");
  assert_katex(rendered);
  assertStringIncludes(rendered, 'class="katex-display"');
});

Deno.test("display math spans multiple lines", () => {
  const source = `before

$$
\\begin{aligned}
a &= b \\\\
c &= d
\\end{aligned}
$$

after`;
  assertEquals(nodes(source, "display_math"), [
    "\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}",
  ]);

  const rendered = html(source);
  assert_katex(rendered);
  assertStringIncludes(rendered, 'class="katex-display"');
  assertStringIncludes(rendered, "before");
  assertStringIncludes(rendered, "after");
});

Deno.test("escaped dollars and currency stay literal", () => {
  const literals = [
    "A literal \\$ sign.",
    "Lunch was $5 and coffee was $3.",
    "Prices: $20, $30, $40.",
    "It went from $5-$10.",
    "\\$x^2\\$ is not math.",
    "Costs $5 today.",
  ];
  for (const source of literals) {
    assertEquals(expand_math(source), source, source);
    const rendered = html(source);
    assert(!rendered.includes("katex"), `unexpected math in: ${source}`);
    assert(!rendered.includes("math_"), `unexpected math in: ${source}`);
  }

  assertStringIncludes(html("Lunch was $5 and coffee was $3."), "$5");
  assertStringIncludes(html("A literal \\$ sign."), "$ sign");
});

Deno.test("code, raw and verbatim content is untouched", () => {
  const inline_code = "Write `$x^2$` to get math.";
  assertEquals(expand_math(inline_code), inline_code);
  assertEquals(nodes(inline_code, "verbatim"), ["$x^2$"]);
  assertEquals(nodes(inline_code, "inline_math"), []);

  const fenced = "```console\n$ echo $HOME and $PATH$\n```\n";
  assertEquals(expand_math(fenced), fenced);
  assertEquals(nodes(fenced, "code_block"), ["$ echo $HOME and $PATH$\n"]);

  const tilde_fenced = "~~~\n$x^2$\n~~~\n";
  assertEquals(expand_math(tilde_fenced), tilde_fenced);
  assertEquals(nodes(tilde_fenced, "code_block"), ["$x^2$\n"]);

  const raw_block = "```=html\n<b>$x^2$</b>\n```\n";
  assertEquals(expand_math(raw_block), raw_block);
  assertEquals(nodes(raw_block, "raw_block"), ["<b>$x^2$</b>\n"]);

  const raw_inline = "`$x^2$`{=html}";
  assertEquals(expand_math(raw_inline), raw_inline);
  assertEquals(nodes(raw_inline, "raw_inline"), ["$x^2$"]);

  const after_fence = "```\n$a$\n```\n\nand $x^2$ here.\n";
  assertEquals(nodes(after_fence, "inline_math"), ["x^2"]);

  // A `$` cannot pair across a verbatim span and swallow it either.
  const around_verbatim = "Costs $5, see `$x$` here.";
  assertEquals(expand_math(around_verbatim), around_verbatim);
  assertEquals(nodes(around_verbatim, "verbatim"), ["$x$"]);
  assertEquals(nodes(around_verbatim, "inline_math"), []);
});

Deno.test("fenced code and raw blocks nested in containers are untouched", () => {
  const blocks: [string, string, string][] = [
    ["~~~\n$x^2$\n~~~\n", "code_block", "$x^2$\n"],
    ["```\n$x^2$\n```\n", "code_block", "$x^2$\n"],
    ["> ~~~\n> $x^2$\n> ~~~\n", "code_block", "$x^2$\n"],
    ["> ```\n> $x^2$\n> ```\n", "code_block", "$x^2$\n"],
    ["- ~~~\n  $x^2$\n  ~~~\n", "code_block", "$x^2$\n"],
    ["- ```\n  $x^2$\n  ```\n", "code_block", "$x^2$\n"],
    ["1. ~~~\n   $x^2$\n   ~~~\n", "code_block", "$x^2$\n"],
    ["> - ~~~\n>   $x^2$\n>   ~~~\n", "code_block", "$x^2$\n"],
    ["> > ~~~\n> > $x^2$\n> > ~~~\n", "code_block", "$x^2$\n"],
    ["~~~=html\n<b>$x^2$</b>\n~~~\n", "raw_block", "<b>$x^2$</b>\n"],
    ["> ~~~=html\n> <b>$x^2$</b>\n> ~~~\n", "raw_block", "<b>$x^2$</b>\n"],
    ["- ~~~=html\n  <b>$x^2$</b>\n  ~~~\n", "raw_block", "<b>$x^2$</b>\n"],
    ["> - ~~~=html\n>   <b>$x^2$</b>\n>   ~~~\n", "raw_block", "<b>$x^2$</b>\n"],
  ];
  for (const [source, tag, text] of blocks) {
    assertEquals(expand_math(source), source, source);
    assertEquals(nodes(source, tag), [text], source);
    assertEquals(nodes(source, "inline_math"), [], source);
  }

  // A block that ends with its container does not swallow the math after it.
  const dedented = "- ~~~\n  $a$\n\n$b$\n";
  assertEquals(nodes(dedented, "code_block"), ["$a$\n\n"]);
  assertEquals(nodes(dedented, "inline_math"), ["b"]);
});

Deno.test("link destinations, autolinks and attributes are never rewritten", () => {
  const untouched = [
    "It costs $5. See [pricing](https://example.com/$pricing).",
    "Costs [$5 plan](https://example.com/$plan).",
    "[text](https://example.com/a$b$c)",
    "<https://example.com/a$b$c>",
    `{cap="a $b$ c"}`,
    `[text]{title="$a$b"}`,
    "[a$b$c]: https://example.com/q$r$s\n",
  ];
  for (const source of untouched) assertEquals(expand_math(source), source, source);

  assertEquals(
    destinations("It costs $5. See [pricing](https://example.com/$pricing)."),
    ["https://example.com/$pricing"],
  );
  assertEquals(
    destinations("Costs [$5 plan](https://example.com/$plan)."),
    ["https://example.com/$plan"],
  );
  assertEquals(
    destinations("[text](https://example.com/a$b$c)"),
    ["https://example.com/a$b$c"],
  );
  assertEquals(nodes("<https://example.com/a$b$c>", "url"), ["https://example.com/a$b$c"]);
  assertEquals(attribute(`[text]{title="$a$b"}`, "title"), ["$a$b"]);
  assertEquals(attribute(`{cap="a $b$ c"}\n![alt](i.png)\n`, "cap"), ["a $b$ c"]);
  assertEquals(
    parse("[a$b$c]: https://example.com/q$r$s\n").references["a$b$c"]?.destination,
    "https://example.com/q$r$s",
  );

  // Math in link text is still expanded; the destination beside it is not.
  const in_text = "[$x^2$ label](https://example.com/a)";
  assertEquals(nodes(in_text, "inline_math"), ["x^2"]);
  assertEquals(destinations(in_text), ["https://example.com/a"]);

  // Braces are only skipped when they are djot attributes, so formulas keep them.
  assertEquals(nodes("$x_{i=1}$", "inline_math"), ["x_{i=1}"]);
  assertEquals(nodes("$\\mathbb{R}$", "inline_math"), ["\\mathbb{R}"]);
  assertEquals(nodes("prose {not attributes} costs $5 and $6", "inline_math"), []);
});

Deno.test("display math inside containers drops the container markers", () => {
  const quoted = "> $$\n> a = b\n> $$\n";
  assertEquals(nodes(quoted, "display_math"), ["a = b"]);

  const listed = "- $$\n  a = b\n  $$\n";
  assertEquals(nodes(listed, "display_math"), ["a = b"]);

  const nested = "> - $$\n>   a = b\n>   $$\n";
  assertEquals(nodes(nested, "display_math"), ["a = b"]);

  const aligned = `> $$
> \\begin{aligned}
> a &= b \\\\
> c &= d
> \\end{aligned}
> $$
`;
  assertEquals(nodes(aligned, "display_math"), [
    "\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}",
  ]);

  for (const source of [quoted, listed, nested, aligned]) {
    for (const formula of nodes(source, "display_math")) {
      assert(!formula.includes(">"), `container marker leaked into: ${formula}`);
    }
    const rendered = html(source);
    assert_katex(rendered);
    assertStringIncludes(rendered, 'class="katex-display"');
  }
});

Deno.test("djot native math syntax still renders", () => {
  const inline = "native $`x^2` here";
  assertEquals(expand_math(inline), inline);
  assertEquals(nodes(inline, "inline_math"), ["x^2"]);
  assert_katex(html(inline));

  const display = "native $$`\\sum_{i=1}^{n} i` here";
  assertEquals(expand_math(display), display);
  assertEquals(nodes(display, "display_math"), ["\\sum_{i=1}^{n} i"]);
  assertStringIncludes(html(display), 'class="katex-display"');
});

Deno.test("formulas containing backticks get a safe fence", () => {
  assertEquals(expand_math("$a`b$"), "$``a`b``");
  assertEquals(nodes("$a`b$", "inline_math"), ["a`b"]);

  assertEquals(expand_math("$a``b$"), "$```a``b```");
  assertEquals(nodes("$a``b$", "inline_math"), ["a``b"]);

  // A formula touching a backtick needs padding so the run does not merge into
  // the generated fence.
  assertEquals(expand_math("$a`$"), "$``a` ``");
  assertEquals(nodes("$a`$", "inline_math"), ["a`"]);

  assertEquals(expand_math("$$ `a` $$"), "$$`` `a` ``");
  assertEquals(nodes("$$ `a` $$", "display_math"), ["`a`"]);

  assertEquals(nodes("$$\\texttt{`}$$", "display_math"), ["\\texttt{`}"]);
  assert_katex(html("$$\\texttt{`}$$"));
});

Deno.test("math next to a verbatim span preserves both nodes", () => {
  const cases = [
    {
      source: "the vector $v$`std::vector` is nice",
      expanded: "the vector $`v`{%%}`std::vector` is nice",
      inline: ["v"],
      display: [],
      verbatim: ["std::vector"],
    },
    {
      source: "$$a$$`code`",
      expanded: "$$`a`{%%}`code`",
      inline: [],
      display: ["a"],
      verbatim: ["code"],
    },
    {
      source: "$a$``code``",
      expanded: "$`a`{%%}``code``",
      inline: ["a"],
      display: [],
      verbatim: ["code"],
    },
  ];

  for (const test of cases) {
    assertEquals(expand_math(test.source), test.expanded);
    assertEquals(nodes(test.source, "inline_math"), test.inline);
    assertEquals(nodes(test.source, "display_math"), test.display);
    assertEquals(nodes(test.source, "verbatim"), test.verbatim);
  }
});

Deno.test("unmatched delimiters stay literal", () => {
  const literals = [
    "$x^2 never closed",
    "$$x^2 never closed",
    "an inline $x^2\nspanning lines$ is not math",
    "$ x^2$ has a space after the opener",
    "$x^2 $ has a space before the closer",
    "$$$$",
  ];
  for (const source of literals) {
    assertEquals(expand_math(source), source, source);
    assertEquals(nodes(source, "inline_math"), [], source);
    assertEquals(nodes(source, "display_math"), [], source);
  }
});

Deno.test("invalid latex fails the build with context", () => {
  const inline = assertThrows(
    () => html("broken $\\notacommand{x}$ math"),
    Error,
    "inline math",
  );
  assertStringIncludes(inline.message, "\\notacommand{x}");
  assertStringIncludes(inline.message, "Undefined control sequence");

  const display = assertThrows(
    () => html("$$\\begin{nosuchenv} x \\end{nosuchenv}$$"),
    Error,
    "display math",
  );
  assertStringIncludes(display.message, "\\begin{nosuchenv}");

  // `strict` also rejects LaTeX-incompatible input that katex could guess at.
  const strict = assertThrows(() => html("$é$"), Error, "inline math");
  assertStringIncludes(strict.message, "strict mode");
});

Deno.test("math renders without any client side script", () => {
  const rendered = html("inline $x^2$ and\n\n$$\\int_0^1 x \\, dx$$\n");
  assert_katex(rendered);
  assert(!rendered.includes("<script"), "math must not need a runtime script");
  assert(!rendered.toLowerCase().includes("mathjax"), "math must not depend on MathJax");
});
