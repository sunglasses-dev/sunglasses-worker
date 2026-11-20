// node --import ./tests/force_store_unlimited.mjs --test tests/*.test.mjs   the whole suite with no limit on the store.
import { setRuleStoreBudget } from "../src/engine.js";
setRuleStoreBudget(Number.MAX_SAFE_INTEGER);
