export type SqlValue = string | number | bigint | null | Uint8Array;

export type Sqlite = {
  all: (sql: string, ...params: SqlValue[]) => unknown[];
  run: (sql: string, ...params: SqlValue[]) => void;
  exec: (sql: string) => void;
  close: () => void;
};

export const openDatabase = async (file: string, mode: "read" | "create"): Promise<Sqlite> => {
  if (typeof Bun !== "undefined") {
    const { Database } = await import("bun:sqlite");
    const db = new Database(file, mode === "read" ? { readonly: true } : { create: true, readwrite: true });
    return {
      all: (sql, ...params) => db.query(sql).all(...params),
      run: (sql, ...params) => db.run(sql, params),
      exec: (sql) => db.exec(sql),
      close: () => db.close(),
    };
  }
  const sqlite = await import("node:sqlite").catch(() => {
    throw new Error(
      `import and export need Node 22.5 or newer (this is Node ${process.versions.node}; before 22.13 start Node with --experimental-sqlite), or Bun`,
    );
  });
  const db = new sqlite.DatabaseSync(file, { readOnly: mode === "read" });
  return {
    all: (sql, ...params) => db.prepare(sql).all(...params),
    run: (sql, ...params) => {
      db.prepare(sql).run(...params);
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
};
