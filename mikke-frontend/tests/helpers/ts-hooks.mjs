// Node から src の TypeScript をそのまま読むための設定（テスト専用）。
// "@/…"（tsconfig の paths）と、拡張子の無い相対 import を、.ts のファイルに読み替える。
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

function withExtension(file) {
  if (existsSync(file) && path.extname(file)) return file;
  if (existsSync(`${file}.ts`)) return `${file}.ts`;
  if (existsSync(path.join(file, "index.ts"))) return path.join(file, "index.ts");
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    let file = null;
    if (specifier.startsWith("@/")) file = withExtension(path.join(SRC, specifier.slice(2)));
    else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:") && !path.extname(specifier)) {
      file = withExtension(path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier));
    }
    return file ? nextResolve(pathToFileURL(file).href, context) : nextResolve(specifier, context);
  },
});
