import { loadRuntimeConfig } from "../src/config/load-config.js";
import { TwitterCliSource } from "../src/sources/x/twitter-cli-source.js";

const args = process.argv.slice(2);
let cliPath: string;
if (args.length === 2 && args[0] === "--env-file" && args[1].startsWith("/")) {
  cliPath = loadRuntimeConfig({ ...process.env, ACE_HUNTER_ENV_FILE: args[1] }).twitterCliPath;
} else if (args.length === 2 && args[0] === "--twitter-cli-path" && args[1].startsWith("/")) {
  cliPath = args[1];
} else {
  cliPath = loadRuntimeConfig(process.env).twitterCliPath;
}
await new TwitterCliSource({ cliPath }).assertAuthenticated();
process.stdout.write("twitter_preflight_passed\n");
