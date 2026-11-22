// node --import ./tests/force_tables_road.mjs --test tests/*.test.mjs   runs the whole suite with every rule reading the
// pinned tables' own classes (the road a Worker takes when its engine's check does not hold).
globalThis.SUNGLASSES_RULE_ROAD = "tables";
