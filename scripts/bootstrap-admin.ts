import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { z } from "zod";
import { getPool, transaction } from "../src/server/db/pool";
import {
  createCredentialAccount,
  lockIdentityStore,
} from "../src/server/auth/credentials";
import {
  hashPassword,
  validPassword,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
} from "../src/server/auth/password";
import {
  BootstrapError,
  bootstrapFailureMessage,
  type BootstrapStage,
} from "./lib/bootstrap-errors";

let stage: BootstrapStage = "reading account details";

/** Read a password from a terminal without echoing it or accepting command-line secrets. */
function hiddenPassword(label: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) throw new BootstrapError("terminal");
  stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (data: string) => {
      for (const character of data) {
        if (character === "\u0003") {
          finish(new BootstrapError("cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        if (character >= " " && character !== "\u001b") value += character;
      }
    };
    stdin.on("data", onData);
  });
}

async function main(): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) throw new BootstrapError("terminal");
  const terminal = createInterface({ input: stdin, output: stdout });
  let email: string;
  let name: string;
  try {
    const emailResult = z
      .string()
      .email()
      .max(254)
      .safeParse(
        (await terminal.question("Administrator email: ")).trim().toLowerCase(),
      );
    if (!emailResult.success) throw new BootstrapError("email");
    email = emailResult.data;
    const nameResult = z
      .string()
      .min(1)
      .max(64)
      .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value))
      .safeParse((await terminal.question("In-game display name: ")).trim());
    if (!nameResult.success) throw new BootstrapError("name");
    name = nameResult.data;
  } finally {
    terminal.close();
  }
  stage = "checking the database";
  if (!process.env.DATABASE_URL) throw new BootstrapError("configured");
  const existing = await getPool().query(
    "SELECT 1 FROM metro_profiles WHERE role = 'admin' LIMIT 1",
  );
  if (existing.rowCount) throw new BootstrapError("existing");
  stage = "reading the password";
  const password = await hiddenPassword(
    `Password (${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} characters): `,
  );
  if (!validPassword(password)) throw new BootstrapError("password");
  if (password !== (await hiddenPassword("Confirm password: ")))
    throw new BootstrapError("confirmation");
  stage = "hashing the password";
  const passwordHash = await hashPassword(password);
  stage = "saving the administrator";
  const id = await transaction(async (client) => {
    await lockIdentityStore(client);
    const existing = await client.query(
      "SELECT user_id FROM metro_profiles WHERE role = 'admin'",
    );
    if (existing.rowCount) throw new BootstrapError("existing");
    const userId = await createCredentialAccount(client, {
      email,
      name,
      role: "admin",
      passwordHash,
    });
    await client.query(
      "INSERT INTO metro_audit (actor_id, action, target_id, outcome) VALUES ($1, 'account.bootstrap', $1, 'success')",
      [userId],
    );
    return userId;
  });
  console.log(`Administrator created (${id}). Sign in through the website.`);
}

main()
  .catch((error: unknown) => {
    console.error(bootstrapFailureMessage(error, stage));
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await getPool().end();
    } catch {
      /* No initialized pool when configuration is absent. */
    }
  });
