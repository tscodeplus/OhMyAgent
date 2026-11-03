// JSON Schema validation (drafts 2020-12 and 7) without eval: compile() builds a schema into plain closures once.
// The builders return plain JSON Schema objects typed with the values they accept.

export {
	type Annotations,
	arr,
	bool,
	bytes,
	int,
	type LengthBounds,
	lit,
	map,
	type NumberBounds,
	nul,
	nullable,
	num,
	Optional,
	obj,
	oneOf,
	opt,
	type Properties,
	type Schema,
	type Static,
	type StaticObject,
	str,
	tuple,
	union,
	unknown,
} from "./builders.js";
export type { Check, CompileOptions, FormatCheck, JsonSchema, ParseResult, ValidationError } from "./types.js";
export { CoercingValidator, compile, Validator } from "./validator.js";
