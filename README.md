# naryene.github.io

Source code for the blog. The `./src` directory contains a deno script that reads `.djot` from
`./content` and writes `.html` to `./out`.

```console
$ deno task build
$ deno task serve
$ deno task test
```

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

credit: [matklad](https://github.com/matklad)
