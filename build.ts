import { mkdir, cp } from "node:fs/promises";

await mkdir("dist/extension", { recursive: true });
await mkdir("dist/connector", { recursive: true });
await cp("public", "dist/extension", { recursive: true });
for (const [entrypoints, outdir, target] of [
  [["src/background.ts", "src/panel.ts"], "dist/extension", "browser"],
  [["native/connector.ts", "native/install.ts"], "dist/connector", "node"],
] as const) {
  const build = await Bun.build({ entrypoints: [...entrypoints], outdir, target, format: "esm", minify: false, sourcemap: "none" });
  if (!build.success) throw new AggregateError(build.logs, `Build failed: ${outdir}`);
}
await Bun.write("dist/connector/package.json", JSON.stringify({ type: "module", private: true, engines: { node: ">=22" } }, null, 2));
await cp("README.md", "dist/README.md");
await cp("LICENSE", "dist/LICENSE");
await cp("docs", "dist/docs", { recursive: true });
console.log("Built dist/extension and dist/connector. No credentials or browsing data included.");
