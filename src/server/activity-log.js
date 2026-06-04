import fs from "node:fs/promises";
import path from "node:path";

export class ActivityLog {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async append(type, message, data = {}) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const entry = {
      time: new Date().toISOString(),
      type,
      message,
      data,
    };
    await fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }

  async recent(limit = 200) {
    try {
      const text = await fs.readFile(this.filePath, "utf8");
      return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(-limit)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { time: "", type: "error", message: line, data: {} };
          }
        })
        .reverse();
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
}

