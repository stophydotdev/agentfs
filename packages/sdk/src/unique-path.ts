const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SUFFIX_LENGTH = 8;
const MAX_STEM = 64;
const EXTENSION = /\.[a-z0-9]{1,8}$/;

const randomSuffix = (): string => {
  const unbiased = Math.floor(0x1_0000_0000 / BASE58.length) * BASE58.length;
  let suffix = "";
  while (suffix.length < SUFFIX_LENGTH) {
    for (const value of crypto.getRandomValues(new Uint32Array(SUFFIX_LENGTH))) {
      if (value >= unbiased) continue;
      suffix += BASE58.charAt(value % BASE58.length);
      if (suffix.length === SUFFIX_LENGTH) break;
    }
  }
  return suffix;
};

const splitExtension = (name: string): [stem: string, extension: string] => {
  const match = EXTENSION.exec(name);
  return match ? [name.slice(0, match.index), match[0]] : [name, ""];
};

const sanitize = (value: unknown): string => {
  const basename = String(value).split(/[/\\]/).pop() ?? "";
  const cleaned = basename.replace(/[\p{Cc}\p{Cf}]+/gu, "").normalize("NFC").toLowerCase();
  const [stem, extension] = splitExtension(cleaned);
  const slug = stem.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, MAX_STEM).replace(/-+$/, "");
  return (slug || "file") + extension;
};

export const uniquePath = (strings: TemplateStringsArray, ...values: unknown[]): string => {
  let path = "";
  strings.forEach((part, index) => {
    path += part.trim();
    if (index < values.length) path += sanitize(values[index]);
  });
  const basenameAt = path.lastIndexOf("/") + 1;
  const [stem, extension] = splitExtension(path.slice(basenameAt));
  return `${path.slice(0, basenameAt)}${stem || "file"}-${randomSuffix()}${extension}`;
};
