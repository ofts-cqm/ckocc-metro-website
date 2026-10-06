import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { z } from "zod";
import { getPool, transaction } from "../src/server/db/pool";
import {
  createCredentialAccount,
  lockIdentityStore,
} from "../src/server/auth/credentials";
import { hashPassword, validPassword } from "../src/server/auth/password";

/** Read a password from a terminal without echoing it or accepting command-line secrets. */
function hiddenPassword(label: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY)
    throw new Error("An interactive terminal is required.");
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
          finish(new Error("Cancelled."));
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
  if (!stdin.isTTY || !stdout.isTTY)
    throw new Error("Run this command in an interactive terminal.");
  const terminal = createInterface({ input: stdin, output: stdout });
  const email = z
    .string()
    .email()
    .max(254)
    .parse(
      (await terminal.question("Administrator email: ")).trim().toLowerCase(),
    );
  const name = z
    .string()
    .min(1)
    .max(64)
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value))
    .parse((await terminal.question("In-game display name: ")).trim());
  terminal.close();
  const password = await hiddenPassword("Password (12–128 characters): ");
  if (!validPassword(password)) throw new Error("Invalid password length.");
  if (password !== (await hiddenPassword("Confirm password: ")))
    throw new Error("Passwords do not match.");
  const passwordHash = await hashPassword(password);
  const id = await transaction(async (client) => {
    await lockIdentityStore(client);
    const existing = await client.query(
      "SELECT user_id FROM metro_profiles WHERE role = 'admin'",
    );
    if (existing.rowCount)
      throw new Error(
        "An administrator already exists. Use an invitation or account recovery process.",
      );
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
  .catch(() => {
    console.error(
      "Administrator bootstrap failed. Check the email, display name, matching password length, migrations, and database connection. Bootstrap requires that no administrator already exists.",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await getPool().end();
    } catch {
      /* No initialized pool when configuration is absent. */
    }
  });
