import { spawn } from "node:child_process";

import { ApiError, type Client, type Device } from "./api";

export function openBrowser(url: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForApproval(client: Client, device: Device, now = () => Date.now(), wait = sleep) {
  const deadline = now() + device.expires_in * 1000;
  let interval = device.interval;
  while (now() < deadline) {
    await wait(interval * 1000);
    try {
      return await client.claimDevice(device.device_code);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.code === "authorization_pending") continue;
      if (error.code === "slow_down") {
        interval = Math.max(interval + 5, error.retryAfter ?? interval);
        continue;
      }
      if (error.code === "access_denied") throw new Error("The login was denied in the browser.");
      if (error.code === "expired_device_code") break;
      throw error;
    }
  }
  throw new Error("The login code expired. Run agentfs login again.");
}
