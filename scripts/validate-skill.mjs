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

await access(`${directory}/agents/openai.yaml`);
process.stdout.write(`validated ${name}\n`);
