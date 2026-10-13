import { Database } from "bun:sqlite";
import { join } from "node:path";

/**
 * 应用侧表（topics/artifacts），与 pi-durable 共用一个 sqlite 文件、独立连接。
 * pi-durable 拥有自己的 schema 与迁移；app_ 前缀的表归这里管。WAL 下同进程多连接安全。
 */
export interface TopicRow {
	id: string; // conversation id
	title: string;
	/** 相对 workspace 的选题目录，如 topics/固态电池-a1b2c3d4 */
	dir: string;
	created_at: number;
}

export interface ArtifactRow {
	id: number;
	topic_id: string;
	type: string;
	stage: string;
	title: string;
	/** 相对选题目录的路径，恒在 artifacts/ 下 */
	rel_path: string;
	size: number;
	excerpt: string | null;
	created_at: number;
}

export interface AppDb {
	insertTopic(row: TopicRow): void;
	getTopic(id: string): TopicRow | undefined;
	listTopics(): TopicRow[];
	insertArtifact(
		row: Omit<ArtifactRow, "id" | "created_at"> & { created_at?: number },
	): number;
	listArtifacts(topicId: string): ArtifactRow[];
	getArtifact(topicId: string, artifactId: number): ArtifactRow | undefined;
	close(): void;
}

export function openAppDb(dataDir: string): AppDb {
	const db = new Database(join(dataDir, "siftory.sqlite"));
	db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;
CREATE TABLE IF NOT EXISTS app_topics (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  dir TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS app_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id TEXT NOT NULL REFERENCES app_topics(id),
  type TEXT NOT NULL,
  stage TEXT NOT NULL,
  title TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  excerpt TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS app_artifacts_topic ON app_artifacts(topic_id);`);

	return {
		insertTopic: (row) => {
			db.query(
				"INSERT INTO app_topics (id, title, dir, created_at) VALUES (?, ?, ?, ?)",
			).run(row.id, row.title, row.dir, row.created_at);
		},
		getTopic: (id) =>
			(db
				.query("SELECT * FROM app_topics WHERE id = ?")
				.get(id) as TopicRow | null) ?? undefined,
		listTopics: () =>
			db
				.query("SELECT * FROM app_topics ORDER BY created_at DESC")
				.all() as TopicRow[],
		insertArtifact: (row) =>
			Number(
				db
					.query(
						`INSERT INTO app_artifacts (topic_id, type, stage, title, rel_path, size, excerpt, created_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						row.topic_id,
						row.type,
						row.stage,
						row.title,
						row.rel_path,
						row.size,
						row.excerpt,
						row.created_at ?? Date.now(),
					).lastInsertRowid,
			),
		listArtifacts: (topicId) =>
			db
				.query(
					"SELECT * FROM app_artifacts WHERE topic_id = ? ORDER BY created_at ASC",
				)
				.all(topicId) as ArtifactRow[],
		getArtifact: (topicId, artifactId) =>
			(db
				.query("SELECT * FROM app_artifacts WHERE topic_id = ? AND id = ?")
				.get(topicId, artifactId) as ArtifactRow | null) ?? undefined,
		close: () => db.close(),
	};
}
