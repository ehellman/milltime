import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../src/cli/main.ts";
import type { Registry } from "../../../src/cli/commands/registry.ts";
import { UsageError } from "../../../src/cli/errors.ts";
import { MilltimeApiError, MilltimeNotLoggedInError } from "../../../src/types.ts";
import { captureCli } from "../../support/cli.ts";

const registry: Registry = {
  demo: {
    summary: "Demo commands",
    commands: {
      echo: {
        summary: "Echo the arguments",
        usage: "[words...]",
        details: "Options:\n  --loud  Shout",
        options: { loud: { type: "boolean" } },
        run: async ({ positionals, values }) => {
          const text = positionals.join(" ");
          return { data: { words: positionals }, text: values.loud ? text.toUpperCase() : text };
        },
      },
      fail: {
        summary: "Fail with the error named by the argument",
        run: async ({ positionals: [kind] }) => {
          if (kind === "login") throw new MilltimeNotLoggedInError();
          if (kind === "usage") throw new UsageError("Bad input.");
          if (kind === "api") throw new MilltimeApiError(500, { success: false, errors: ["Boom"] });
          throw new Error("Unexpected");
        },
      },
    },
  },
};

async function run(...argv: string[]) {
  const cli = captureCli();
  const code = await main(argv, cli.ctx, registry);
  return { code, stdout: cli.stdout.join("\n"), stderr: cli.stderr.join("\n") };
}

describe("cli main", () => {
  it("runs a command and prints its text", async () => {
    assert.deepEqual(await run("demo", "echo", "hello", "world", "--loud"), {
      code: 0,
      stdout: "HELLO WORLD",
      stderr: "",
    });
  });

  it("prints the command's data as JSON with --json", async () => {
    const { code, stdout } = await run("demo", "echo", "hi", "--json");
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout), { words: ["hi"] });
  });

  it("prints compact JSON for scripts and pretty JSON on a terminal", async () => {
    const piped = captureCli();
    await main(["demo", "echo", "hi", "--json"], piped.ctx, registry);
    assert.equal(piped.stdout.join(""), '{"words":["hi"]}');

    const terminal = captureCli({ overrides: { stdoutIsTerminal: true } });
    await main(["demo", "echo", "hi", "--json"], terminal.ctx, registry);
    assert.equal(terminal.stdout.join(""), '{\n  "words": [\n    "hi"\n  ]\n}');
  });

  it("prints the version", async () => {
    assert.deepEqual(await run("--version"), { code: 0, stdout: "1.2.3", stderr: "" });
  });

  it("lists every command in the top-level help", async () => {
    for (const argv of [["--help"], ["help"]]) {
      const { code, stdout } = await run(...argv);
      assert.equal(code, 0);
      assert.match(stdout, /demo echo +Echo the arguments/);
      assert.match(stdout, /demo fail +Fail with/);
    }
  });

  it("prints help to stderr and exits 2 without arguments", async () => {
    const { code, stdout, stderr } = await run();
    assert.equal(code, 2);
    assert.equal(stdout, "");
    assert.match(stderr, /Usage: milltime/);
  });

  it("shows group and command help", async () => {
    for (const argv of [["demo"], ["demo", "--help"], ["help", "demo"]]) {
      assert.match((await run(...argv)).stdout, /Usage: milltime demo <command>/);
    }
    for (const argv of [["demo", "echo", "--help"], ["help", "demo", "echo"]]) {
      const { stdout } = await run(...argv);
      assert.match(stdout, /Usage: milltime demo echo \[words\.\.\.\] \[options\]/);
      assert.match(stdout, /--loud  Shout/);
    }
  });

  it("exits 2 for unknown commands and options", async () => {
    for (const argv of [["nope"], ["demo", "nope"], ["demo", "echo", "--nope"], ["help", "nope"]]) {
      const { code, stderr } = await run(...argv);
      assert.equal(code, 2, argv.join(" "));
      assert.match(stderr, /Run "milltime help" for usage/);
    }
  });

  it("maps errors to exit codes", async () => {
    assert.deepEqual(await run("demo", "fail", "login"), {
      code: 3,
      stdout: "",
      stderr: 'Not logged in. Run "milltime auth login".',
    });
    assert.equal((await run("demo", "fail", "usage")).code, 2);

    const api = await run("demo", "fail", "api");
    assert.equal(api.code, 1);
    assert.match(api.stderr, /Milltime error: .*Boom/);

    const other = await run("demo", "fail");
    assert.equal(other.code, 1);
    assert.equal(other.stderr, "Error: Unexpected");
  });
});
