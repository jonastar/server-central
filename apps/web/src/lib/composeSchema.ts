import rawSchema from "./compose-spec.schema.json";

/** Vendored from compose-spec/compose-spec, `schema/compose-spec.json`, pinned so a
 *  schema change is a deliberate re-vendor rather than something that shifts under us.
 *  To update: re-fetch the raw file at a newer commit and bump this constant. */
export const COMPOSE_SCHEMA_SOURCE = {
    commit: "4e2fe7602af8c965ab4fef891e9dde9c5940775f",
    fetchedAt: "2026-08-15",
    url: "https://github.com/compose-spec/compose-spec/blob/4e2fe7602af8c965ab4fef891e9dde9c5940775f/schema/compose-spec.json",
} as const;

export interface JsonSchema {
    type?: string | string[];
    enum?: unknown[];
    description?: string;
    properties?: Record<string, JsonSchema>;
    patternProperties?: Record<string, JsonSchema>;
    items?: JsonSchema;
    oneOf?: JsonSchema[];
    anyOf?: JsonSchema[];
    $ref?: string;
    additionalProperties?: boolean | JsonSchema;
    required?: string[];
    [key: string]: unknown;
}

export const composeSpecSchema = rawSchema as unknown as JsonSchema;

/** Resolves a `#/$defs/...` ref against the root schema — the only ref shape
 *  compose-spec.json uses. */
export function resolveSchemaRef(node: JsonSchema, root: JsonSchema = composeSpecSchema): JsonSchema {
    if (!node.$ref) {
        return node;
    }
    const path = node.$ref.replace(/^#\//, "").split("/");
    let cur: unknown = root;
    for (const seg of path) {
        cur = (cur as Record<string, unknown> | undefined)?.[seg];
    }
    if (!cur) {
        throw new Error(`Unresolvable schema $ref: ${node.$ref}`);
    }
    return resolveSchemaRef(cur as JsonSchema, root);
}

/** The per-service schema node (`#/$defs/service`), resolved once. */
export const serviceSchema: JsonSchema = resolveSchemaRef({ $ref: "#/$defs/service" });

export function servicePropertySchema(field: string): JsonSchema | undefined {
    const node = serviceSchema.properties?.[field];
    return node ? resolveSchemaRef(node) : undefined;
}
