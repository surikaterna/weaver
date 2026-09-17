// Git repository clone/pull management

import { consoleLogger, extractErrorMessage } from "@weaver-conf/config-engine";
import { createWeaverError } from "@weaver-conf/config-types";
import type { SimpleGit } from "simple-git";

/** Result of a git operation — success with data or failure with error details. */
export type GitOperationResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string; retryable: boolean };

/** Options for creating a git manager (repo URL, local path, branch, auth). */
export interface GitManagerOptions {
  repoUrl: string;
  localPath: string;
  branch?: string | undefined;
  token?: string | undefined;
  git?: SimpleGit | undefined;
}

/** Manages a local git clone — handles clone, pull, commit+push, and revert operations. */
export interface GitManager {
  ensureClone(): Promise<GitOperationResult>;
  refresh(): Promise<GitOperationResult>;
  commitAndPush(message: string, files: string[]): Promise<GitOperationResult>;
  /** Replicate committed local authority without pull/rebase/checkout/reset. */
  commitAndReplicate?(
    message: string,
    files: string[],
  ): Promise<GitOperationResult>;
  revert(
    toRevision: string,
    actor: string,
  ): Promise<GitOperationResult<{ revertedCommits: number }>>;
  readonly localPath: string;
  /** Pins checkout mutation admission behind the manager queue; release is instance-bound. */
  retainLocalAuthority?(): Promise<() => void>;
}

function injectToken(repoUrl: string, token: string): string {
  const url = new URL(repoUrl);
  url.username = token;
  return url.toString();
}

function isTransientError(err: unknown): boolean {
  const message = extractErrorMessage(err);
  return /timeout|ECONNREFUSED|ENOTFOUND|network|fetch/.test(message);
}

function toFailure(err: unknown): {
  success: false;
  error: string;
  retryable: boolean;
} {
  const message = extractErrorMessage(err).replace(
    /https:\/\/[^\s/@]+@/g,
    "https://[redacted]@",
  );
  consoleLogger.error(`[weaver] Git operation failed: ${message}`);
  return { success: false, error: message, retryable: isTransientError(err) };
}

class LocalGitManager implements GitManager {
  private mutexChain: Promise<unknown> = Promise.resolve();
  private readonly authorityOwners = new Set<symbol>();
  constructor(
    readonly localPath: string,
    private readonly authUrl: string,
    private readonly branch: string,
    private readonly git: SimpleGit,
  ) {}
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.mutexChain.then(fn);
    this.mutexChain = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  retainLocalAuthority(): Promise<() => void> {
    return this.serialize(async () => {
      const token = Symbol("local-authority");
      this.authorityOwners.add(token);
      return () => {
        this.authorityOwners.delete(token);
      };
    });
  }
  private assertMutableCheckout(): void {
    if (this.authorityOwners.size)
      throw createWeaverError(
        "UNSUPPORTED_AUTHORITY",
        "Local checkout is pinned by provider authority; only replication is allowed",
      );
  }

  async ensureClone(): Promise<GitOperationResult> {
    try {
      return await this.serialize(async () => {
        this.assertMutableCheckout();
        const { existsSync } = await import("node:fs");
        const { join } = await import("node:path");

        if (existsSync(join(this.localPath, ".git"))) {
          await this.git.cwd(this.localPath);
          await this.git.pull(["--rebase"]);
        } else {
          await this.git.clone(this.authUrl, this.localPath, [
            "--branch",
            this.branch,
          ]);
          await this.git.cwd(this.localPath);
        }
        return { success: true, data: undefined };
      });
    } catch (err) {
      return toFailure(err);
    }
  }

  async refresh(): Promise<GitOperationResult> {
    try {
      return await this.serialize(async () => {
        this.assertMutableCheckout();
        await this.git.cwd(this.localPath);
        await this.git.pull(["--rebase"]);
        return { success: true, data: undefined };
      });
    } catch (err) {
      return toFailure(err);
    }
  }

  async commitAndPush(
    message: string,
    files: string[],
  ): Promise<GitOperationResult> {
    if (files.length === 0) return { success: true, data: undefined };
    try {
      return await this.serialize(async () => {
        this.assertMutableCheckout();
        await this.git.cwd(this.localPath);
        for (const file of files) {
          await this.git.add(file);
        }
        await this.git.commit(message);
        await this.git.pull(["--rebase"]);
        await this.git.push();
        return { success: true, data: undefined };
      });
    } catch (err) {
      return toFailure(err);
    }
  }

  async commitAndReplicate(
    message: string,
    files: string[],
  ): Promise<GitOperationResult> {
    try {
      return await this.serialize(async () => {
        await this.git.cwd(this.localPath);
        for (const file of files) await this.git.add(file);
        if ((await this.git.status()).staged.length > 0)
          await this.git.commit(message);
        await this.git.push(this.authUrl, this.branch);
        return { success: true, data: undefined };
      });
    } catch (error) {
      return toFailure(error);
    }
  }

  async revert(
    toRevision: string,
    actor: string,
  ): Promise<GitOperationResult<{ revertedCommits: number }>> {
    try {
      return await this.serialize(async () => {
        this.assertMutableCheckout();
        await this.git.cwd(this.localPath);
        const log = await this.git.log({ from: toRevision, to: "HEAD" });
        const commitCount = log.total;
        if (commitCount === 0) {
          return { success: true, data: { revertedCommits: 0 } };
        }
        await this.git.raw(["revert", "--no-commit", `${toRevision}..HEAD`]);
        await this.git.commit(`rollback: revert to ${toRevision} by ${actor}`);
        await this.git.push();
        return {
          success: true,
          data: { revertedCommits: commitCount },
        };
      });
    } catch (err) {
      return toFailure(err);
    }
  }
}

export function createGitManager(options: GitManagerOptions): GitManager {
  if (!options.git)
    throw createWeaverError(
      "UNSUPPORTED_AUTHORITY",
      "SimpleGit instance is required",
    );
  const authUrl = options.token
    ? injectToken(options.repoUrl, options.token)
    : options.repoUrl;
  return new LocalGitManager(
    options.localPath,
    authUrl,
    options.branch ?? "main",
    options.git,
  );
}
