// node --import ./tests/force_store_smallest.mjs --test tests/*.test.mjs   the whole suite with the store of compiled rule
// regexes at its smallest size: only the regex read last is held, every other read builds it again.
import { setRuleStoreBudget } from "../src/engine.js";
setRuleStoreBudget(1);
