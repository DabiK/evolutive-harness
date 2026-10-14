// Cliquet : une mesure de qualité ne peut pas se dégrader d'un ticket à l'autre.
// Le plancher (scripts/quality/baseline.json) n'est resserré que par la boucle, après un ticket validé.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.mjs";
import { directions, measure } from "./metrics.mjs";

export const BASELINE = "scripts/quality/baseline.json";

export function readBaseline(root) {
  const file = path.join(root, BASELINE);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

/** Compare des mesures au plancher. Une mesure absente du plancher n'est pas contrôlée. */
export function compare(baseline, current, senses) {
  const regressions = [];
  const improvements = [];
  for (const [key, direction] of Object.entries(senses)) {
    if (!(key in baseline) || !(key in current)) continue;
    const before = baseline[key];
    const now = current[key];
    if (now === before) continue;
    const worse = direction === "max" ? now > before : now < before;
    (worse ? regressions : improvements).push({ key, before, now, direction });
  }
  return { regressions, improvements };
}

/** Nouveau plancher : chaque mesure prend la meilleure des deux valeurs, jamais la pire. */
export function tighten(baseline, current, senses) {
  const next = { ...baseline };
  for (const [key, direction] of Object.entries(senses)) {
    if (!(key in current)) continue;
    if (!(key in next)) next[key] = current[key];
    else next[key] = direction === "max" ? Math.min(next[key], current[key]) : Math.max(next[key], current[key]);
  }
  return next;
}

export function writeBaseline(root, values, senses) {
  const ordered = Object.fromEntries(Object.keys(senses).filter((k) => k in values).map((k) => [k, values[k]]));
  fs.writeFileSync(path.join(root, BASELINE), JSON.stringify(ordered, null, 2) + "\n");
}

// Usage direct : `node scripts/quality/ratchet.mjs` affiche les mesures ;
// `--init` crée le plancher s'il n'existe pas ; `--tighten` le resserre sans jamais le relâcher.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd();
  const config = await loadConfig(root);
  const senses = directions(config);
  const current = measure(root, config);
  const baseline = readBaseline(root);
  if (process.argv.includes("--init")) {
    if (baseline) {
      console.error("Le plancher existe déjà : il ne se réinitialise pas, il se resserre (--tighten).");
      process.exit(1);
    }
    writeBaseline(root, current, senses);
  } else if (process.argv.includes("--tighten")) {
    if (!baseline) {
      console.error("Aucun plancher : lancer d'abord --init.");
      process.exit(1);
    }
    writeBaseline(root, tighten(baseline, current, senses), senses);
  }
  console.log(JSON.stringify(current, null, 2));
}
