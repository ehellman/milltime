import { createInterface } from "node:readline/promises";
import { UsageError } from "./errors.ts";

export interface Prompt {
  /** Asks for a line of text; an empty answer returns `defaultValue`. */
  line(question: string, defaultValue?: string): Promise<string>;
  /** Asks for a secret without echoing it. */
  password(question: string): Promise<string>;
}

export interface PromptInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}

const ENTER = new Set(["\r", "\n"]);
const BACKSPACE = new Set(["\u007f", "\b"]);
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";

/** Prompts on the terminal, written to `output` (stderr) so stdout stays clean for --json. */
export function createTerminalPrompt(input: PromptInput, output: NodeJS.WritableStream): Prompt {
  const requireTerminal = (question: string) => {
    if (!input.isTTY) throw new UsageError(`No terminal to ask "${question}"; pass it as an option (see --help).`);
  };

  return {
    async line(question, defaultValue) {
      requireTerminal(question);
      const readline = createInterface({ input, output });
      try {
        const hint = defaultValue ? ` [${defaultValue}]` : "";
        const answer = (await readline.question(`${question}${hint}: `)).trim();
        return answer || defaultValue || "";
      } finally {
        readline.close();
      }
    },
    async password(question) {
      requireTerminal(question);
      output.write(`${question}: `);
      return readHidden(input).finally(() => output.write("\n"));
    },
  };
}

function readHidden(input: PromptInput): Promise<string> {
  return new Promise((resolve, reject) => {
    let secret = "";
    const finish = (settle: () => void) => {
      input.removeListener("data", onData);
      input.setRawMode?.(false);
      input.pause();
      settle();
    };
    const onData = (chunk: Buffer | string) => {
      for (const char of chunk.toString("utf8")) {
        if (ENTER.has(char)) return finish(() => resolve(secret));
        if (char === CTRL_C || (char === CTRL_D && secret === "")) {
          return finish(() => reject(new UsageError("Cancelled.")));
        }
        if (BACKSPACE.has(char)) secret = secret.slice(0, -1);
        else if (char >= " ") secret += char;
      }
    };
    input.setRawMode?.(true);
    input.on("data", onData);
    input.resume();
  });
}
