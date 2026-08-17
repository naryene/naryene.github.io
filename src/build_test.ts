import { assert, assertEquals, assertStringIncludes } from "std/assert/mod.ts";
import * as fs from "std/fs/mod.ts";

Deno.test("a full build ships the local katex stylesheet and fonts", async () => {
  await fs.emptyDir("./out");

  const build = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--lock",
      "--allow-write=./out,./build",
      "--allow-read=./out,./build,./content",
      "--allow-net",
      "--allow-import",
      "./src/main.ts",
      "build",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await build.output();
  assertEquals(code, 0, new TextDecoder().decode(stderr));

  const css = await Deno.readTextFile("./out/res/css/katex.min.css");
  const fonts = [...css.matchAll(/url\(([^)]+)\)/g)].map((match) => match[1]);
  assert(fonts.length > 0, "the katex stylesheet references no fonts");
  for (const font of fonts) {
    assertStringIncludes(font, "katex-fonts/");
    assert(
      await fs.exists(`./out/res/css/${font}`),
      `missing font referenced by the built stylesheet: ${font}`,
    );
  }

  const index = await Deno.readTextFile("./out/res/index.html");
  assertStringIncludes(index, '<link rel="stylesheet" href="/css/katex.min.css">');
  assert(!index.includes("katex.min.js"), "generated pages must not load KaTeX JavaScript");
});
