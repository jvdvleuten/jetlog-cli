import { createInterface } from "node:readline/promises";

/** Asks a yes/no question on stderr (stdout stays data only). Anything but y or yes is a no. */
export async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
