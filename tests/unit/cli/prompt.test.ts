import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createTerminalPrompt } from "../../../src/cli/prompt.ts";
import { UsageError } from "../../../src/cli/errors.ts";

function fakeTerminal() {
  const rawModes: boolean[] = [];
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: (mode: boolean) => rawModes.push(mode),
  });
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => (written += chunk));
  return { input, output, rawModes, written: () => written };
}

describe("terminal prompt", () => {
  it("reads a password without echoing it, handling backspace", async () => {
    const terminal = fakeTerminal();
    const prompt = createTerminalPrompt(terminal.input, terminal.output);

    const answer = prompt.password("Password");
    terminal.input.write("hunx\u007fter2\r");

    assert.equal(await answer, "hunter2");
    assert.equal(terminal.written(), "Password: \n");
    assert.deepEqual(terminal.rawModes, [true, false]);
  });

  it("cancels on Ctrl-C", async () => {
    const terminal = fakeTerminal();
    const answer = createTerminalPrompt(terminal.input, terminal.output).password("Password");
    terminal.input.write("abc\u0003");

    await assert.rejects(answer, UsageError);
    assert.deepEqual(terminal.rawModes, [true, false]);
  });

  it("reads a line and falls back to the default", async () => {
    const terminal = fakeTerminal();
    const prompt = createTerminalPrompt(terminal.input, terminal.output);

    const answer = prompt.line("Username", "user");
    terminal.input.write("\n");

    assert.equal(await answer, "user");
    assert.match(terminal.written(), /Username \[user\]: /);
  });

  it("asks for flags when there is no terminal", async () => {
    const input = new PassThrough();
    const prompt = createTerminalPrompt(input, new PassThrough());

    await assert.rejects(prompt.line("Username"), /pass it as an option/);
    await assert.rejects(prompt.password("Password"), /pass it as an option/);
  });
});
