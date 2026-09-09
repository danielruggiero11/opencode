import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"

/**
 * `opencode sidecar` — runs the cdp-web Copilot sidecar HTTP server in-process.
 *
 * This is the COMPILED entry for the sidecar (the `bun run sidecar.ts` dev path
 * lives in the module's own `import.meta.main` block). Bundling it as a
 * subcommand means the shipped opencode binary serves it directly, so Lumen Lite
 * needs no separate `bun` install or source checkout — the supervisor
 * (`services/copilot/web_sidecar.py`) resolves the bundled binary and runs
 * `opencode sidecar --http-port <n> --port <cdp>`.
 *
 * instance:false — the sidecar needs no project InstanceContext (it only drives
 * the portable browser primitives), matching `serve`/`web`.
 */
export const SidecarCommand = effectCmd({
  command: "sidecar",
  describe: "run the cdp-web Copilot sidecar HTTP server",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("port", {
        type: "number",
        describe: "CDP debug port of the shared Chrome to drive (default 9224)",
      })
      .option("http-port", {
        type: "number",
        describe: "HTTP port for the sidecar to listen on (default 9725)",
      })
      .option("headless", {
        type: "boolean",
        describe: "launch Chrome headless if the sidecar has to start it",
        default: false,
      }),
  handler: Effect.fn("Cli.sidecar")(function* (args) {
    const { runSidecar } = yield* Effect.promise(
      () => import("../../provider/cdp-web/sidecar"),
    )
    runSidecar({
      cdpPort: args.port,
      httpPort: args["http-port"],
      headless: args.headless,
    })
    // The sidecar owns its own http server + signal handlers; hold the CLI
    // process open so it keeps serving until terminated.
    yield* Effect.never
  }),
})
