import { spawnSync } from "node:child_process";

export type GitStatus = {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
};

export function parseGitStatus(output: string): GitStatus | null {
  let branch = "";
  let oid = "";
  let dirty = false;
  let ahead = 0;
  let behind = 0;

  for (const line of output.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      branch = line.slice("# branch.head ".length).trim();
    } else if (line.startsWith("# branch.oid ")) {
      oid = line.slice("# branch.oid ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(line);
      if (match) {
        ahead = Number.parseInt(match[1], 10);
        behind = Number.parseInt(match[2], 10);
      }
    } else if (line.trim() && !line.startsWith("#")) {
      dirty = true;
    }
  }

  if (branch === "(detached)") {
    branch = oid && oid !== "(initial)" ? oid.slice(0, 7) : "detached";
  }

  return branch ? { branch, dirty, ahead, behind } : null;
}

export function readGitStatus(cwd: string): GitStatus | null {
  if (!cwd) {
    return null;
  }

  const result = spawnSync(
    "git",
    ["--no-optional-locks", "status", "--porcelain=v2", "--branch"],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // A huge repository should cost the branch name, not a frozen statusline.
      timeout: 500,
    },
  );

  if (result.error || result.status !== 0) {
    return null;
  }

  return parseGitStatus(result.stdout);
}
