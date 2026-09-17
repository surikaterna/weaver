import { spawn } from "node:child_process";

const deadlines = new Set();
export const SUBPROCESS_STDERR_CAP_BYTES = 16 * 1024;

export function startWorker(start) {
  const worker = new URL("./upgrade-two-provider-subprocess-worker.mjs", import.meta.url);
  const child = spawn(process.execPath, ["--import", "tsx", worker.pathname], {
    detached: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const protocol = messageProtocol(child);
  const state = exitState(child, protocol);
  const handle = {
    child,
    exit: state.exit,
    get exited() { return state.exited; },
    get exitResult() { return state.result; },
    get stderr() { return protocol.stderr; },
    get pending() { return protocol.pending; },
    get queued() { return protocol.queued; },
    send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); },
    next(type, milliseconds = 10_000) {
      return protocol.next(type, milliseconds);
    },
    nextAny(milliseconds = 10_000) {
      return protocol.next(undefined, milliseconds);
    },
    wait(milliseconds = 10_000) {
      return deadline(milliseconds, (resolve, reject) => {
        state.exit.then(resolve, reject);
        return () => {};
      }, () => `Worker exit deadline: ${protocol.stderr}`);
    },
  };
  handle.send(start);
  return handle;
}

export function activeSubprocessDeadlines() {
  return deadlines.size;
}

function messageProtocol(child) {
  const messages = [];
  const waiters = new Set();
  let stdout = "";
  let stderrBytes = Buffer.alloc(0);
  let stderrTotalBytes = 0;
  const accept = (message) => {
    const waiter = [...waiters].find((item) =>
      item.type === undefined || item.type === message.type);
    if (!waiter) messages.push(message);
    else {
      waiters.delete(waiter);
      waiter.resolve(message);
    }
  };
  const onStdout = (chunk) => {
    stdout += chunk;
    while (stdout.includes("\n")) {
      const boundary = stdout.indexOf("\n");
      const line = stdout.slice(0, boundary);
      stdout = stdout.slice(boundary + 1);
      if (line) accept(JSON.parse(line));
    }
  };
  const onStderr = (chunk) => {
    stderrTotalBytes += chunk.length;
    stderrBytes = retainTail(stderrBytes, chunk);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);
  const stderr = () => formatStderr(stderrBytes, stderrTotalBytes);
  return {
    get stderr() { return stderr(); },
    get pending() { return waiters.size; },
    get queued() { return messages.length; },
    next: (type, milliseconds) => nextMessage(messages, waiters, type, milliseconds,
      stderr),
    fail(error) {
      for (const waiter of waiters) waiter.reject(error);
      waiters.clear();
    },
    detach() {
      child.stdout.removeListener("data", onStdout);
      child.stderr.removeListener("data", onStderr);
    },
  };
}

function retainTail(retained, chunk) {
  if (chunk.length >= SUBPROCESS_STDERR_CAP_BYTES)
    return Buffer.from(chunk.subarray(-SUBPROCESS_STDERR_CAP_BYTES));
  const combinedLength = retained.length + chunk.length;
  if (combinedLength <= SUBPROCESS_STDERR_CAP_BYTES)
    return Buffer.concat([retained, chunk], combinedLength);
  const keep = SUBPROCESS_STDERR_CAP_BYTES - chunk.length;
  return Buffer.concat([retained.subarray(retained.length - keep), chunk],
    SUBPROCESS_STDERR_CAP_BYTES);
}

function formatStderr(retained, totalBytes) {
  const text = retained.toString("utf8");
  if (totalBytes <= SUBPROCESS_STDERR_CAP_BYTES) return text;
  return `[stderr truncated: retained ${retained.length}/${totalBytes} bytes; cap ${SUBPROCESS_STDERR_CAP_BYTES}]\n${text}`;
}

function nextMessage(messages, waiters, type, milliseconds, stderr) {
  const index = type === undefined
    ? (messages.length ? 0 : -1)
    : messages.findIndex((message) => message.type === type);
  if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
  return deadline(milliseconds, (resolve, reject) => {
    const waiter = { type, resolve, reject };
    waiters.add(waiter);
    return () => waiters.delete(waiter);
  }, () => `Worker ${type} deadline: ${stderr()}`);
}

function exitState(child, protocol) {
  const state = { exited: false, result: undefined, exit: undefined };
  state.exit = new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    child.once("error", onError);
    child.once("exit", (code, signal) => {
      state.exited = true;
      state.result = { code, signal };
      child.removeListener("error", onError);
      protocol.detach();
      protocol.fail(new Error(`Worker exited ${code ?? signal}: ${protocol.stderr}`));
      resolve(state.result);
    });
  });
  return state;
}

function deadline(milliseconds, subscribe, diagnostic) {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      deadlines.delete(timer);
      unsubscribe();
      reject(new Error(diagnostic()));
    }, milliseconds);
    deadlines.add(timer);
    const settle = (operation) => (value) => {
      clearTimeout(timer);
      deadlines.delete(timer);
      unsubscribe();
      operation(value);
    };
    unsubscribe = subscribe(settle(resolve), settle(reject));
  });
}
