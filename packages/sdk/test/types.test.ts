import { expect, test } from "bun:test";

import { Bucket, uploadHandler, uploadRoute } from "../src/index";
import { uploadHooks } from "../src/react";

const handler = uploadHandler({
  bucket: new Bucket({ token: "afs_key", bucket: "site" }),
  context: () => ({ id: "u7" }),
  onBeforeUpload: ({ ctx, file }) => ({ path: `${ctx.id}/${file.name}` }),
  routes: {
    avatar: uploadRoute<{ id: string }>()({ onUploadComplete: ({ ctx }) => ({ owner: ctx.id }) }),
    attachment: {},
  },
});

const hooks = uploadHooks<typeof handler>();

export const typedRoutes = () => {
  const avatar = hooks.useUpload("avatar");
  const owner: string | undefined = avatar.upload?.blob?.data.owner;
  hooks.useUpload("attachment");
  // @ts-expect-error: no such route
  hooks.useUpload("nope");
  return owner;
};

export const needsOnBeforeUpload = () => [
  // @ts-expect-error: a route with no onBeforeUpload of its own needs the handler's
  uploadHandler({ bucket: new Bucket({ token: "afs_key", bucket: "site" }), routes: { attachment: {} } }),
  // @ts-expect-error: a handler with no routes needs onBeforeUpload
  uploadHandler({ bucket: new Bucket({ token: "afs_key", bucket: "site" }) }),
  uploadHandler({ bucket: new Bucket({ token: "afs_key", bucket: "site" }), routes: { attachment: { onBeforeUpload: ({ file }) => ({ path: file.name }) } } }),
];

test("route names and completion data are typed from the handler", () => {
  expect(typeof typedRoutes).toBe("function");
});
