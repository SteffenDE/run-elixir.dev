// Boot the Emscripten BEAM under Node and evaluate an expression.
//
//   node playground/beam/smoke.mjs ['io:format("~p~n", [erlang:system_info(otp_release)])']
//
// The VM's file system is MEMFS: the dist's application ebins are copied
// into /otp/lib/<app>/ebin before main runs.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
// A dist build.sh wrote (BEAM_WASM; default the site's), with its otp/.
const dist = process.env.BEAM_WASM ?? join(root, "out/beam-wasm/site");
const otp = join(dist, "otp");
const apps = (process.env.APPS ?? "kernel,stdlib,compiler").split(",");
const expr =
  process.argv[2] ??
  'io:format("hello from ~s on ~p~n", [erlang:system_info(otp_release), erlang:system_info(system_architecture)])';

const { default: createModule } = await import(join(dist, "beam.mjs"));

const args = ["--", "-root", "/otp", "-bindir", "/otp/bin", "-progname", "erl",
  "-home", "/home", "-boot", "/otp/bin/vm", "-noshell",
  "-kernel", "start_distribution", "false"];
for (const app of apps) args.push("-pa", `/otp/lib/${app}/ebin`);
args.push("-eval", `${expr}, erlang:halt(0).`);

const started = performance.now();
await createModule({
  arguments: args,
  print: (s) => console.log(s),
  printErr: (s) => console.error(s),
  onExit: (code) => {
    console.error(`exit ${code} after ${Math.round(performance.now() - started)} ms`);
  },
  preRun: [
    (mod) => {
      mod.FS_mkdirTree("/otp/bin");
      mod.FS_mkdirTree("/home");
      mod.FS_mkdirTree("/tmp");
      mod.FS_createDataFile("/otp/bin/vm.boot", null, readFileSync(join(dist, "vm.boot")), true, true, true);
      for (const app of apps) {
        const ebin = join(otp, "lib", app, "ebin");
        if (!existsSync(ebin)) throw new Error(`missing ${ebin}`);
        mod.FS_mkdirTree(`/otp/lib/${app}/ebin`);
        for (const file of readdirSync(ebin)) {
          mod.FS_createDataFile(`/otp/lib/${app}/ebin`, file, readFileSync(join(ebin, file)), true, true, true);
        }
      }
    },
  ],
});
