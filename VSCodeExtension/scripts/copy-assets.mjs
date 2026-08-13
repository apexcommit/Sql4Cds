import { cp, mkdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = dirname(root);
await mkdir(join(root, "images"), { recursive: true });
await cp(join(repo, "AzureDataStudioExtension", "images"), join(root, "images"), { recursive: true });

const candidates = [
  join(repo, "MarkMpn.Sql4Cds.LanguageServer", "bin", "Release", "net8.0"),
  join(repo, "MarkMpn.Sql4Cds.LanguageServer", "bin", "Debug", "net8.0")
];
let service;
for (const candidate of candidates) {
  try {
    await access(join(candidate, "MarkMpn.Sql4Cds.LanguageServer.dll"), constants.R_OK);
    service = candidate;
    break;
  } catch { /* try the next build output */ }
}
if (!service) {
  throw new Error("Build MarkMpn.Sql4Cds.LanguageServer before packaging the VS Code extension.");
}
await mkdir(join(root, "out"), { recursive: true });
await cp(service, join(root, "out", "sql4cdstoolsservice"), { recursive: true });
