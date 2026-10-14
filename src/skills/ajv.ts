/**
 * Shared ajv instance for the skills framework (design D2): every manifest's
 * parameters JSON Schema is compiled exactly once — at load — and the same
 * instance renders descriptive validation errors at dispatch.
 */

// Named import: ajv ships CJS, so this is the NodeNext-compatible form.
import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";

export const ajv = new Ajv({ allErrors: true });

/** Human-readable summary of the collected ajv errors ("data.x must be …"). */
export function validationErrorText(validate: ValidateFunction): string {
  return ajv.errorsText(validate.errors);
}
