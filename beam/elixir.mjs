// Run `elixir ARGS...` on the Emscripten BEAM under Node, as the host's
// bin/elixir starts erl. Needs a build linked with -sNODERAWFS=1, so the VM
// sees the host's file system and working directory:
//
//   EXTRA_LINK=-sNODERAWFS=1 OPT=-O2 DIST=out/beam-wasm/node \
//     playground/beam/build.sh release
//   BEAM_WASM=out/beam-wasm/node BEAM_WASM_OTP=out/beam-wasm/releaseO2/otp \
//     SCHEDULERS=4 \
//     node playground/beam/elixir.mjs script.exs
//
// OTP's libraries come from the build tree the dist was made from (its
// patched kernel), Elixir's from the host installation (ELIXIR_ROOT, or the
// `elixir` on PATH).
import { execFileSync } from "node:child_process";
import { readdirSync, realpathSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const dist = resolve(process.env.BEAM_WASM ?? join(root, "out/beam-wasm/node"));
const otp = resolve(process.env.BEAM_WASM_OTP ?? join(dist, "../otp"));
const elixirRoot =
  process.env.ELIXIR_ROOT ??
  join(dirname(dirname(realpathSync(execFileSync("which", ["elixir"]).toString().trim()))), "lib");
const schedulers = process.env.SCHEDULERS ?? "4";

const otpApps = readdirSync(join(otp, "lib")).filter((app) =>
  existsSync(join(otp, "lib", app, "ebin")),
);
// Emulator flags go to beam directly, without erlexec: -S, not +S.
const args = ["-S", `${schedulers}:${schedulers}`, "--", "-root", otp, "-bindir", join(otp, "bin"),
  "-progname", "erl", "-home", process.env.HOME, "-boot", join(dist, "vm"),
  "-noshell", "-kernel", "start_distribution", "false"];
for (const app of otpApps) args.push("-pa", join(otp, "lib", app, "ebin"));
args.push("-elixir_root", elixirRoot, "-pa", join(elixirRoot, "elixir/ebin"),
  "-s", "elixir", "start_cli", "-extra", ...process.argv.slice(2));

const { default: createModule } = await import(join(dist, "beam.mjs"));
await createModule({
  arguments: args,
  print: (s) => process.stdout.write(s + "\n"),
  printErr: (s) => {
    if (!s.includes("Heap resize call")) process.stderr.write(s + "\n");
  },
  onExit: (code) => process.exit(code),
});
