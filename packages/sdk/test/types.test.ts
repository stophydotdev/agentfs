import { expect, test } from "bun:test";

import { Bucket, uploadHandler, uploadRoute } from "../src/index";
import { uploadHooks } from "../src/react";

const handler = uploadHandler({
  bucket: new Bucket({ token: "afs_key", bucket: "site" }),
  context: () => ({ id: "u7" }),
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

test("route names and completion data are typed from the handler", () => {
  expect(typeof typedRoutes).toBe("function");
});
