import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

const PARALLEL = 32;

export const sha256Of = async (file: string) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};

export const inParallel = async <Item, Result>(
  items: Item[],
  work: (item: Item) => Promise<Result>,
) => {
  const results: Result[] = [];
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < items.length; index = next++) {
      const item = items[index];
      if (item !== undefined) results[index] = await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
  return results;
};
