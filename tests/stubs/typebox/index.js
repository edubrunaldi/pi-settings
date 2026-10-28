export const Type = {
	Object: (props) => ({ kind: "object", props }),
	String: (options) => ({ kind: "string", options }),
	Array: (items, options) => ({ kind: "array", items, options }),
	Optional: (schema) => ({ ...schema, optional: true }),
};
