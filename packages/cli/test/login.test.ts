import { expect, test } from "bun:test";

import { ApiError, type Client, type Device } from "../src/api";
import { safeWebUrl, waitForApproval } from "../src/login";

const device: Device = {
  device_code: "dc",
  user_code: "ABCD-EFGH",
  verification_uri: "https://agentfs.cloud/device",
  verification_uri_complete: "https://agentfs.cloud/device?code=ABCD-EFGH",
  expires_in: 900,
  interval: 5,
};

test("login keeps polling through pending and slow_down, then returns the key", async () => {
  const answers = [
    new ApiError(428, "authorization_pending", "pending", 5),
    new ApiError(429, "slow_down", "slow", 12),
    { api_key: "afs_new", default_project: "default" },
  ];
  const waits: number[] = [];
  const client = {
    claimDevice: async () => {
      const next = answers.shift();
      if (next instanceof ApiError) throw next;
      return next;
    },
  } as unknown as Client;

  const token = await waitForApproval(client, device, () => 0, async (ms) => {
    waits.push(ms);
  });

  expect(token).toEqual({ api_key: "afs_new", default_project: "default" });
  expect(waits).toEqual([5000, 5000, 12000]);
});

test("a denied login stops with a clear message", async () => {
  const client = {
    claimDevice: async () => {
      throw new ApiError(403, "access_denied", "denied", undefined);
    },
  } as unknown as Client;

  await expect(waitForApproval(client, device, () => 0, async () => {})).rejects.toThrow("denied in the browser");
});

test("only web links are opened", () => {
  expect(safeWebUrl("https://agentfs.cloud/device?code=AB")).toBe("https://agentfs.cloud/device?code=AB");
  expect(safeWebUrl("file:///etc/passwd")).toBeUndefined();
  expect(safeWebUrl("javascript:alert(1)")).toBeUndefined();
});
