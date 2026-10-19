#!/usr/bin/env node
// PostToolUse(Agent) : dans une session de ticket, enregistre le verdict de chaque relecteur, rattaché à la
// revue qu'il a lue, et garde son rapport. La boucle n'intègre qu'un changement dont la dernière relecture est « accepté ».
import { recordReview, reviewVerdict, uncorrectedFindings } from "../../scripts/loop/reviewed-state.mjs";
import { loopMode, projectDir, readInput } from "./lib.mjs";

const input = readInput();
const ticket = process.env.HARNESS_TICKET;
if (!loopMode || !ticket || input.tool_input?.subagent_type !== "relecteur") process.exit(0);

const response = input.tool_response || {};
const parts = Array.isArray(response.content) ? response.content : [];
const report = response.handbackReport?.text ?? parts.map((part) => part?.text || "").join("\n");
// La demande porte le type de relecture : le rang et l'interdiff peuvent aussi appartenir à une revue complète.
const correction = /^[\t ]*Fais une relecture de correction\.[\t ]*\r?$/mu.test(input.tool_input?.prompt || "");
let verdict = reviewVerdict(report);
if (correction && uncorrectedFindings(report) > 0) verdict = "à corriger";
recordReview(projectDir(input), ticket, { verdict, modele: response.resolvedModel, report });
