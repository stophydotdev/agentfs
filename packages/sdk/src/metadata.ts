import { BlobError } from "./errors";

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

export const checkMetadata = (metadata: Record<string, string> | undefined): Record<string, string> | undefined => {
  if (metadata === undefined) return undefined;
  const checked: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!HEADER_NAME.test(key)) throw new BlobError("invalid_input", { message: `metadata key "${key}" is not a valid header name` });
    if (typeof value !== "string") throw new BlobError("invalid_input", { message: `metadata.${key} must be a string` });
    if (!PRINTABLE_ASCII.test(value)) {
      throw new BlobError("invalid_input", {
        message: `metadata.${key} has characters storage does not carry back unchanged`,
        hint: "metadata is printable ASCII; percent-encode anything else with encodeURIComponent",
      });
    }
    checked[key.toLowerCase()] = value;
  }
  return checked;
};
