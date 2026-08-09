# naryene.github.io

Source code for the blog. The `./src` directory contains a deno script that reads `.djot` from
`./content` and writes `.html` to `./out`.

```console
$ deno task test
$ deno task build
$ deno task serve
```

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

credit: [matklad](https://github.com/matklad)
