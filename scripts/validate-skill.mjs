import { access, readFile } from "node:fs/promises";
import process from "node:process";

const directory = process.argv[2];
if (!directory) throw new Error("skill directory is required");

const text = await readFile(`${directory}/SKILL.md`, "utf8");
const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/);
if (!frontmatter) throw new Error("SKILL.md frontmatter is missing");

const name = frontmatter[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
const description = frontmatter[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
if (!name || !/^[a-z0-9-]{1,64}$/.test(name)) throw new Error("skill name is invalid");
if (!description) throw new Error("skill description is missing");

const manifestPath = `${directory}/agents/openai.yaml`;
await access(manifestPath);
const manifest = await readFile(manifestPath, "utf8");
if (!/^interface:\s*$/mu.test(manifest)) throw new Error("openai.yaml interface is missing");

const displayName = interfaceString(manifest, "display_name");
const shortDescription = interfaceString(manifest, "short_description");
const defaultPrompt = interfaceString(manifest, "default_prompt");
if (!displayName) throw new Error("openai.yaml display_name must not be empty");
if (shortDescription.length < 25 || shortDescription.length > 64) {
  throw new Error("openai.yaml short_description must be 25-64 characters");
}
if (!defaultPrompt.includes(`$${name}`)) {
  throw new Error(`openai.yaml default_prompt must include $${name}`);
}

process.stdout.write(`validated ${name}\n`);

function interfaceString(text, key) {
  const matches = [...text.matchAll(new RegExp(`^ {2}${key}:\\s*(.+)$`, "gmu"))];
  if (matches.length !== 1) throw new Error(`openai.yaml ${key} must appear exactly once`);
  const raw = matches[0][1].trim();
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const value = JSON.parse(raw);
      if (typeof value === "string") return value;
    } catch {
      throw new Error(`openai.yaml ${key} contains invalid quoted text`);
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replaceAll("''", "'");
  throw new Error(`openai.yaml ${key} must be quoted`);
}
