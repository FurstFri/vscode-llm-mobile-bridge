import { spawn } from "node:child_process";

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export function runCommand(
  command: string,
  args: readonly string[],
  timeoutMs = 10_000,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

export async function commandExists(command: string): Promise<boolean> {
  try {
    const result = await runCommand(command, ["--version"], 3_000);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
