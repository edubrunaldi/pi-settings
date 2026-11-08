// Host stub for `typebox` — only the surface `extensions/` imports.
//
// The real TypeBox builds JSON Schema objects; here a schema is just a tagged literal, which is
// enough for `tests/run.mjs` to load a module graph and to assert that a tool declares its
// parameters. The real schemas are exercised by `tests/load-check.mjs` (Pi's own loader) and by
// Pi at call time. Keep this surface in sync with the imports in `extensions/`.
export const Type = {
	Object: (props, options) => ({ kind: "object", props, options }),
	String: (options) => ({ kind: "string", options }),
	Number: (options) => ({ kind: "number", options }),
	Boolean: (options) => ({ kind: "boolean", options }),
	Array: (items, options) => ({ kind: "array", items, options }),
	Optional: (schema) => ({ ...schema, optional: true }),
	Union: (schemas, options) => ({ kind: "union", schemas, options }),
	Record: (key, value, options) => ({ kind: "record", key, value, options }),
	Literal: (value) => ({ kind: "literal", value }),
	Any: () => ({ kind: "any" }),
	Unknown: () => ({ kind: "unknown" }),
};
