import { existsSync, mkdirSync, openSync, readFileSync, closeSync, writeSync, rmSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Siftory home: config, credentials, sessions, logs under one root (default ~/.siftory).
 * Agent workspace: default tool cwd at <home>/workspace. Both resolved to absolute
 * paths at entry so nothing downstream re-joins relative paths (NodeExecutionEnv
 * double-joins relative cwd).
 */
/**
 * @param {{ home?: string; cwd?: string }} [options]
 */
export function resolveHome(options = {}) {
	const home = options.home ? resolve(options.home) : join(homedir(), ".siftory");
	const cwd = options.cwd ? resolve(options.cwd) : join(home, "workspace");
	return { home, cwd, agentDir: join(home, "agent"), sessionsDir: join(home, "sessions") };
}

/** @param {{ home: string; agentDir: string; sessionsDir: string }} paths */
export function initHome({ home, agentDir, sessionsDir }) {
	for (const dir of [join(home, "workspace"), agentDir, join(agentDir, "extensions"), sessionsDir, join(home, "logs"), join(home, "tmp")]) {
		mkdirSync(dir, { recursive: true });
	}
}

/** @param {number} pid */
function isPidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (/** @type {any} */ error) {
		return error.code === "EPERM";
	}
}

/**
 * Exclusive ownership of one session storage directory via sessions/<id>/owner.lock.
 * A live owner PID blocks the second open; a dead one (crashed process) is taken
 * over. This is the host-side lock durable does not provide: same storage must
 * never be driven by two processes.
 */
/**
 * @param {string} sessionDir
 * @param {{ pid?: number }} [options]
 */
export async function acquireSessionLock(sessionDir, { pid = process.pid } = {}) {
	mkdirSync(sessionDir, { recursive: true });
	const lockPath = join(sessionDir, "owner.lock");
	const owner = { pid, startedAt: Date.now(), command: process.argv.join(" ") };
	let fd;
	try {
		fd = openSync(lockPath, "wx");
	} catch (/** @type {any} */ error) {
		if (error.code !== "EEXIST") throw error;
		let previous = null;
		try {
			previous = JSON.parse(readFileSync(lockPath, "utf8"));
		} catch {
			// Unreadable lock: treat as stale only when its PID is dead or absent.
		}
		if (previous && Number.isInteger(previous.pid) && isPidAlive(previous.pid)) {
			throw new Error(
				`session storage is owned by pid ${previous.pid} (${previous.command ?? "unknown"}); refusing to open it twice`,
			);
		}
		rmSync(lockPath, { force: true });
		fd = openSync(lockPath, "wx");
	}
	writeSync(fd, JSON.stringify(owner));
	return () => {
		try {
			closeSync(fd);
		} finally {
			rmSync(lockPath, { force: true });
		}
	};
}

/** @param {string} sessionsDir */
function listSessionIds(sessionsDir) {
	if (!existsSync(sessionsDir)) return [];
	return readdirSyncSafe(sessionsDir)
		.map((name) => ({ name, dir: join(sessionsDir, name) }))
		.filter(({ name, dir }) => /^[a-z0-9-]+$/.test(name) && existsSync(join(dir, "state.sqlite")))
		.sort((a, b) => b.name.localeCompare(a.name))
		.map(({ name }) => name);
}

/** @param {string} dir */
function readdirSyncSafe(dir) {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

export function newSessionId(now = new Date()) {
	const stamp = [
		now.getFullYear(),
		String(now.getMonth() + 1).padStart(2, "0"),
		String(now.getDate()).padStart(2, "0"),
	].join("") + "-" + [
		String(now.getHours()).padStart(2, "0"),
		String(now.getMinutes()).padStart(2, "0"),
		String(now.getSeconds()).padStart(2, "0"),
	].join("-");
	return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Pick the session to open: explicit id, the most recent (--continue), or a fresh one. */
/**
 * @param {string} sessionsDir
 * @param {{ continueLatest?: boolean; sessionId?: string }} [options]
 */
export function pickSession(sessionsDir, { continueLatest = false, sessionId } = {}) {
	const ids = listSessionIds(sessionsDir);
	if (sessionId) {
		// An explicit id opens that storage when its directory exists (it may hold only a lock so far).
		if (!existsSync(join(sessionsDir, sessionId))) throw new Error(`session not found: ${sessionId}`);
		return sessionId;
	}
	if (continueLatest && ids.length > 0) return ids[0];
	return newSessionId();
}

/** @param {string} sessionsDir @param {string} sessionId */
export function sessionDir(sessionsDir, sessionId) {
	return join(sessionsDir, sessionId);
}

export { isAbsolute };
