import { expect, test } from "bun:test";

import { uniquePath } from "../src/index";

test("uniquePath slugs the interpolated name and adds a random suffix before the extension", () => {
  const path = uniquePath`avatars/${"u7"}/${"My Photo (1).PNG"}`;
  expect(path).toMatch(/^avatars\/u7\/my-photo-1-[1-9A-HJ-NP-Za-km-z]{8}\.png$/);
  expect(uniquePath`x/${"../../etc/passwd"}`).toMatch(/^x\/passwd-[1-9A-HJ-NP-Za-km-z]{8}$/);
  expect(uniquePath`a/${"a"}`).not.toBe(uniquePath`a/${"a"}`);
});
