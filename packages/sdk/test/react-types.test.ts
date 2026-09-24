import { expect, test } from "bun:test";

import { Bucket, uploadHandler, uploadRoute } from "../src/index";
import { uploadHooks, type UnboundUploadHooks } from "../src/react";

const bucket = new Bucket({ token: "afs_key", bucket: "site" });

const named = uploadHandler({
  bucket,
  onBeforeUpload: ({ file }) => ({ path: file.name }),
  routes: {
    avatar: uploadRoute()({ onUploadComplete: () => ({ owner: "u7" }) }),
    attachment: {},
  },
});

const sole = uploadHandler({ bucket, onBeforeUpload: ({ file }) => ({ path: file.name }), onUploadComplete: () => ({ saved: true }) });

export const typed = () => {
  const unbound: UnboundUploadHooks = uploadHooks();
  unbound.useUpload("/api/upload");

  const namedHooks = uploadHooks<typeof named>();
  const avatar = namedHooks.useUpload("avatar", { concurrency: 2, onDone: (upload) => upload.blob.data.owner.toUpperCase() });
  const owner: string | undefined = avatar.upload?.blob?.data.owner;
  // @ts-expect-error: a handler with named routes needs the route
  namedHooks.useUpload();
  // @ts-expect-error: no such route
  namedHooks.useUpload("nope");

  const soleHooks = uploadHooks<typeof sole>();
  const saved: boolean | undefined = soleHooks.useUpload().upload?.blob?.data.saved;
  soleHooks.useUpload({ onError: (upload) => upload.error.code });
  const record = avatar.start({ file: new File([], "a") });
  const records = avatar.start({ files: [] });
  return [owner, saved, record?.status, records.length];
};

test("uploadHooks is unbound without a handler type and typed by the handler's routes with one", () => {
  expect(typeof typed).toBe("function");
});
