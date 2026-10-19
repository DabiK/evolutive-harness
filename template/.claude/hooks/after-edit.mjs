#!/usr/bin/env node
// PostToolUse(Edit|Write|apply_patch) : contrôle rapide de chaque fichier de code écrit. L'édition a déjà eu lieu ;
// le retour sert à corriger tout de suite plutôt qu'à la fin du ticket.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEFAULTS, loadConfig } from "../../scripts/quality/config.mjs";
import { isCode } from "../../scripts/quality/metrics.mjs";
import { block, editPaths, projectDir, readInput, relative } from "./lib.mjs";

const input = readInput();
const root = projectDir(input);

let config = DEFAULTS;
try {
  config = await loadConfig(root);
} catch (error) {
  // Configuration illisible : le contrôle rapide la signale lui-même, le filtre garde les fichiers de code par défaut.
  config = DEFAULTS;
}

const failures = [];
for (const target of new Set(editPaths(input))) {
  const file = relative(root, target);
  if (file.startsWith("..") || !fs.existsSync(path.join(root, file))) continue;
  if (!isCode(config, file) && file !== "harness.config.mjs") continue;
  const check = spawnSync(process.execPath, ["scripts/check.mjs", "--file", file], { cwd: root, encoding: "utf8" });
  if (check.status !== 0) failures.push(`Contrôle rapide en échec sur ${file} :\n${(check.stdout || "") + (check.stderr || "")}`);
}
if (failures.length) block(failures.join("\n"));
