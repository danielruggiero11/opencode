import { Cause, Deferred, Duration, Effect, Exit, Fiber } from "effect"
import type { ChildProcess } from "node:child_process"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"

const processes = new WeakMap<ChildProcessHandle, ChildProcess>()

export const register = (handle: ChildProcessHandle, process: ChildProcess) => {
  processes.set(handle, process)
}

export const drain = <E, R>(
  handle: ChildProcessHandle,
  drains: ReadonlyArray<Effect.Effect<unknown, E, R>>,
  options?: { readonly grace?: Duration.Input; readonly onClose?: () => void },
) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const fibers = yield* Effect.forEach(drains, (drain) => Effect.forkDetach(drain))
      let closed = false
      const close = Effect.sync(() => {
        if (closed) return
        closed = true
        options?.onClose?.()
        const process = processes.get(handle)
        process?.stdout?.destroy()
        process?.stderr?.destroy()
        for (const stream of process?.stdio.slice(3) ?? []) {
          if (stream && "readable" in stream && stream.readable) stream.destroy()
        }
        for (const fiber of fibers) fiber.interruptUnsafe()
      })
      const failed = yield* Deferred.make<Cause.Cause<E>>()
      const observers = fibers.map((fiber) =>
        fiber.addObserver((exit) => {
          if (Exit.isFailure(exit)) Deferred.doneUnsafe(failed, Effect.succeed(exit.cause))
        }),
      )
      const run = Effect.gen(function* () {
        const outcome = yield* Effect.raceAllFirst([
          handle.exitCode.pipe(
            Effect.exit,
            Effect.map((exit) => ({ type: "exit" as const, exit })),
          ),
          Deferred.await(failed).pipe(Effect.map((cause) => ({ type: "failure" as const, cause }))),
        ])
        for (const remove of observers) remove()
        if (outcome.type === "failure") {
          yield* close
          yield* handle.kill({ forceKillAfter: "1 second" }).pipe(Effect.ignore)
          return yield* Effect.failCause(outcome.cause)
        }

        const exits = yield* Effect.forEach(fibers, (fiber) => Fiber.await(fiber), { concurrency: "unbounded" }).pipe(
          Effect.timeoutOrElse({ duration: options?.grace ?? "1 second", orElse: () => Effect.succeed(undefined) }),
        )
        if (exits) {
          const failure = exits.find((exit) => Exit.isFailure(exit))
          if (failure) return yield* Effect.failCause(failure.cause)
        } else {
          yield* close
        }
        return Exit.isFailure(outcome.exit) ? yield* Effect.failCause(outcome.exit.cause) : outcome.exit.value
      })
      return yield* restore(run).pipe(Effect.onInterrupt(() => close))
    }),
  )

export * as ProcessOutput from "./process-output"
