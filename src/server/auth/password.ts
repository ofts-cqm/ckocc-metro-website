import { hash, verify, type Options } from "@node-rs/argon2";

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;
// @node-rs/argon2 declares Algorithm as an ambient const enum. The documented numeric value
// avoids emitting an enum reference, which is incompatible with Next.js isolatedModules.
const options = {
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} satisfies Options;

export function validPassword(password: unknown): password is string {
  return (
    typeof password === "string" &&
    password.length >= MIN_PASSWORD_LENGTH &&
    password.length <= MAX_PASSWORD_LENGTH
  );
}

/** The native library generates a cryptographically random salt for every hash. */
export function hashPassword(password: string): Promise<string> {
  if (!validPassword(password))
    throw new Error("Password must contain 12 to 128 characters.");
  return hash(password, options);
}

export async function verifyPassword(input: {
  hash: string;
  password: string;
}): Promise<boolean> {
  if (!validPassword(input.password)) return false;
  try {
    return await verify(input.hash, input.password);
  } catch {
    return false;
  }
}

export function needsRehash(encoded: string): boolean {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(encoded);
  return (
    !match ||
    Number(match[1]) < options.memoryCost ||
    Number(match[2]) < options.timeCost ||
    Number(match[3]) < options.parallelism
  );
}
