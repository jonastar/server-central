import Ajv2020 from "ajv/dist/2020";
import type { ErrorObject } from "ajv";
import { composeSpecSchema } from "./composeSchema";

// compose-spec.json declares $schema draft/2020-12 — the plain `Ajv` export only
// understands draft-07, hence Ajv2020 here.
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateFn = ajv.compile(composeSpecSchema);

export interface ComposeValidationError {
    path: string;
    message: string;
}

/** Validates an already-parsed compose object (e.g. `doc.toJSON()`) against the
 *  vendored Compose Specification schema. Pure schema-shape validation — it does
 *  not catch things only `docker compose config` knows (interpolation, semantic
 *  rejections); that's what `validateComposeContent` is for. */
export function validateComposeObject(value: unknown): ComposeValidationError[] {
    const ok = validateFn(value);
    if (ok) {
        return [];
    }
    return (validateFn.errors ?? []).map((e: ErrorObject) => ({
        path: e.instancePath || "/",
        message: e.message ?? "invalid",
    }));
}
