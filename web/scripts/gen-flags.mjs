// 生成 src/flags.generated.css：只包含 countries.ts 里列出的国家/地区。
// flag-icons 自带的 CSS 引用了全部 271 面 4x3 + 1x1 旗帜，直接引入会让产物膨胀到 5 MB
// 并整体嵌进主控二进制；这里按实际用到的清单裁剪（约 400 KB）。
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const listFile = path.join(root, "src/lib/countries.ts");
const outFile = path.join(root, "src/flags.generated.css");

const codes = [...new Set([...readFileSync(listFile, "utf8").matchAll(/code:\s*"([a-z-]+)"/g)].map((m) => m[1]))]
  .filter(Boolean)
  .sort();

if (codes.length === 0) {
  throw new Error(`未能从 ${listFile} 解析出国家代码`);
}

const base = `/* 由 scripts/gen-flags.mjs 生成，请勿手改（改 src/lib/countries.ts 后重新构建）。 */
.fi {
  position: relative;
  display: inline-block;
  width: 1.333333em;
  line-height: 1em;
  background-size: contain;
  background-position: 50%;
  background-repeat: no-repeat;
}
.fi::before {
  content: " ";
}
`;

const rules = codes
  .map((c) => `.fi-${c} {\n  background-image: url("../node_modules/flag-icons/flags/4x3/${c}.svg");\n}`)
  .join("\n");

writeFileSync(outFile, `${base}\n${rules}\n`);
console.log(`gen-flags: ${codes.length} 面旗帜 → ${path.relative(root, outFile)}`);
