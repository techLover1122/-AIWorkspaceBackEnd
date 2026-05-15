const PREFIX = "\x1b[36m[ai-ide-backend]\x1b[0m";

export function info(...args: unknown[]) {
  console.log(PREFIX, ...args);
}

export function error(...args: unknown[]) {
  console.error(PREFIX, "\x1b[31m[ERROR]\x1b[0m", ...args);
}

export function debug(...args: unknown[]) {
  if (process.env.DEBUG) {
    console.log(PREFIX, "\x1b[33m[DEBUG]\x1b[0m", ...args);
  }
}

export function warn(...args: unknown[]) {
  console.warn(PREFIX, "\x1b[33m[WARN]\x1b[0m", ...args);
}
