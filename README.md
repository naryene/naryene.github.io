# naryene.github.io

Source code for the blog. The `./src` directory contains a deno script that reads `.djot` from
`./content` and writes `.html` to `./out`.

```console
$ deno task test
$ deno task build
$ deno task serve
```

## Analytics

Page views are counted with [GoatCounter](https://www.goatcounter.com). Statistics are
available at <https://naryene.goatcounter.com> and start only after the analytics script is
deployed. Visitors using an analytics blocker may not be counted.

## Code blocks

Fenced blocks carry an optional language identifier, and optional attributes on the line above:

````text
{cap="Hello world" highlight="2"}
```rust
fn main() {
    println!("hello");
}
```
````

The identifier is shown verbatim as a static label next to the caption; blocks without one are
labelled `text`. Languages registered with Highlight.js (its bundled set plus `Zig`, `ungrammar`
and the built-in `console` prompt/output rendering) are highlighted at build time. Anything else
falls back to escaped plain text, so an unknown identifier never fails the build. Highlighting is
static: no JavaScript is shipped to the browser.

## Authoring

Code blocks are fenced, with the language right after the fence:

````
```zig
const x = 1;
```
````

Math is rendered with [KaTeX](https://katex.org) at build time, so pages ship static HTML plus
MathML and load no scripts:

- inline: `$x^2 + y^2$`
- display, on one or several lines: `$$\sum_{i=1}^{n} i$$`
- literal dollar: `\$`

Djot's native ``$`x^2` `` and ``$$`x^2` `` still work. Dollars are left alone inside code blocks,
raw blocks and verbatim spans -- including ones nested in blockquotes and list items -- and inside
link destinations, autolinks, reference definitions and attributes, so a URL like
`https://example.com/a$b$c` survives. Prose like `$5 and $6` stays literal, and invalid LaTeX fails
the build. The KaTeX stylesheet and fonts are vendored under `content/css/` and linked from every
page (see `LICENSE-THIRD-PARTY.md`).

## Blogroll

`build` and `watch` never touch the network: the blogroll is rendered from
`content/blogroll-cache.json`, which is refreshed from the feeds listed in
`content/blogroll.txt` by

```console
$ deno task update-blogroll
$ deno task test
```

Feeds that fail to refresh keep their cached entries and print a warning, so
adding or removing a feed means refreshing and committing the cache in the same
change: `deno task test` fails when the cache does not cover exactly the feeds
in `content/blogroll.txt`. CI runs the same tests on every pull request and
push, and refreshes the cache in its own checkout on the nightly schedule.

credit: [matklad](https://github.com/matklad)
