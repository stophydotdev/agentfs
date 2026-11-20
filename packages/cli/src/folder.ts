export const folder = (path: string) => {
  const trimmed = path.replace(/^\/+|\/+$/gu, "");
  return trimmed === "" ? "" : `${trimmed}/`;
};
