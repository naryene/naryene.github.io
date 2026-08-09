# naryene.github.io

Source code for the blog. The `./src` directory contains a deno script that reads `.djot` from
`./content` and writes `.html` to `./out`.

```console
$ deno task build
$ deno task serve
```

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
