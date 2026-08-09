# naryene.github.io

Source code for the blog. The `./src` directory contains a deno script that reads `.djot` from
`./content` and writes `.html` to `./out`.

The visual layer is a local research-notebook theme in `content/css/notebook.css`.

```console
$ deno task build
$ deno task serve
```

credit: [matklad](https://github.com/matklad)
