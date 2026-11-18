import { dpd } from "../carriers/dpd/index.js";
import { register, type RegisteredPlugin } from "./registry.js";

/**
 * Every carrier plug-in shipped with the server. Each carrier lives in its own folder under
 * `src/carriers/` and imports only the plug-in API; it is registered here with `register()`.
 */
export const BUILTIN_CARRIERS: readonly RegisteredPlugin[] = [register(dpd)];
