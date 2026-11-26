import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bundleExtension } from "../dist/build/bundle.js";

const source = new URL("../dist/src/", import.meta.url);
const outputs = new Map(readdirSync(source, { recursive: true })
  .filter(file => file.endsWith(".js"))
  .map(file => [file, readFileSync(new URL(file, source), "utf8")]));
writeFileSync(fileURLToPath(new URL("index.js", source)), bundleExtension(outputs));
