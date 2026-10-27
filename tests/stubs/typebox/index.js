export const Type = {
	Object: (props) => ({ kind: "object", props }),
	String: (options) => ({ kind: "string", options }),
	Optional: (schema) => ({ ...schema, optional: true }),
};
