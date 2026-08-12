// Test-only fakes for the two OS-boundary injection seams in the
// codebase: qmdRunner's SpawnFn (child_process.spawn) and submit.ts's
// WriteRecordFn (atomicWriteFile). Both exist so tests can assert on, and
// deterministically simulate failure of, an OS-level boundary that is
// impractical to fault-inject reliably and portably for real.

import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { QmdChildProcess, SpawnFn } from "../src/qmdRunner.ts";

export type RecordedSpawnCall = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

class FakeChildProcess extends EventEmitter implements QmdChildProcess {
  readonly stdout: Readable;
  readonly stderr: Readable;

  constructor(stdout: string, stderr: string) {
    super();
    this.stdout = Readable.from(stdout.length > 0 ? [stdout] : []);
    this.stderr = Readable.from(stderr.length > 0 ? [stderr] : []);
  }
}

/**
 * Emits 'spawn' immediately, then emits 'close' only once BOTH stdout and
 * stderr have finished emitting their data ('end'). This mirrors real
 * child_process: 'close' fires after the process exits AND its stdio
 * streams have closed, which is what guarantees a listener attached to
 * 'close' has already seen every 'data' event. Firing 'close' on a fixed
 * timer instead (as an earlier version of this fake did) is a real bug:
 * it can resolve the caller's promise before a Readable created via
 * Readable.from() has actually delivered its chunk, silently truncating
 * stdout.
 */
function driveToClose(child: FakeChildProcess, code: number): void {
  let stdoutEnded = false;
  let stderrEnded = false;
  const maybeClose = () => {
    if (stdoutEnded && stderrEnded) child.emit("close", code);
  };
  child.stdout.on("end", () => {
    stdoutEnded = true;
    maybeClose();
  });
  child.stderr.on("end", () => {
    stderrEnded = true;
    maybeClose();
  });
  child.emit("spawn");
  // Kick both streams into flowing mode. executeQmdInvocation also
  // attaches its own 'data' listener, so this is redundant but harmless
  // when it runs first, and necessary when a test drives the fake
  // directly without going through executeQmdInvocation.
  child.stdout.resume();
  child.stderr.resume();
}

/**
 * A spawnFn that records every call it receives and, for each call in
 * order, either succeeds (emits 'spawn', delivers stdout/stderr, then
 * 'close' with the given code) or never starts (emits only 'error', no
 * 'spawn' — modeling ENOENT / exec failure).
 */
export function makeScriptedSpawnFn(
  script: Array<{ ranProcess: true; code: number; stdout?: string; stderr?: string } | { ranProcess: false; errorMessage: string }>,
): { spawnFn: SpawnFn; calls: RecordedSpawnCall[] } {
  const calls: RecordedSpawnCall[] = [];
  let callIndex = 0;

  const spawnFn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env });
    const step = script[Math.min(callIndex, script.length - 1)];
    callIndex++;

    if (step === undefined) {
      throw new Error("makeScriptedSpawnFn: no script step available for this call");
    }

    const child = new FakeChildProcess(step.ranProcess ? (step.stdout ?? "") : "", step.ranProcess ? (step.stderr ?? "") : "");

    queueMicrotask(() => {
      if (step.ranProcess) {
        driveToClose(child, step.code);
      } else {
        child.emit("error", new Error(step.errorMessage));
      }
    });

    return child;
  };

  return { spawnFn, calls };
}

/** Convenience: a spawnFn that always succeeds with the given stdout, for
 * scripting a `qmd collection add` bootstrap call followed by a `qmd
 * update` call (or any fixed sequence) without listing every step. */
export function makeAlwaysSucceedsSpawnFn(stdout: string): { spawnFn: SpawnFn; calls: RecordedSpawnCall[] } {
  const calls: RecordedSpawnCall[] = [];
  const spawnFn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env });
    const child = new FakeChildProcess(stdout, "");
    queueMicrotask(() => driveToClose(child, 0));
    return child;
  };
  return { spawnFn, calls };
}

/** A spawnFn where every call fails to start at all (models qmd not being
 * on PATH, or any other exec-time failure before the OS process exists). */
export function makeNeverStartsSpawnFn(errorMessage: string): { spawnFn: SpawnFn; calls: RecordedSpawnCall[] } {
  const calls: RecordedSpawnCall[] = [];
  const spawnFn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd, env: options.env });
    const child = new FakeChildProcess("", "");
    queueMicrotask(() => child.emit("error", new Error(errorMessage)));
    return child;
  };
  return { spawnFn, calls };
}
