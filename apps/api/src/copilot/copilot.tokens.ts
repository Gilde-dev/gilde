export const COPILOT_CONFIG = Symbol('COPILOT_CONFIG');
export const COPILOT_MASTRA = Symbol('COPILOT_MASTRA');
/** The enabled scout (config + bot user) or null when it is off. */
export const SCOUT_SETUP = Symbol('SCOUT_SETUP');
/** ScoutState: the scout setup (or null) with the reason it is off. */
export const SCOUT_STATE = Symbol('SCOUT_STATE');
/** Why the scout is off although SCOUT_ENABLED=true, or null (also null whenever the scout is on). */
export const SCOUT_DISABLED_REASON = Symbol('SCOUT_DISABLED_REASON');
/** ScoutThreads of the scout, or null when it is off. */
export const SCOUT_THREADS = Symbol('SCOUT_THREADS');
/** Native delivery gate of the scout (bound to ScoutSignalService when the scout is on). */
export const SCOUT_GATE = Symbol('SCOUT_GATE');
/** ScoutSignalService, or null when the scout is off. */
export const SCOUT_SIGNALS = Symbol('SCOUT_SIGNALS');
/** The enabled Verfijner (config + bot user) or null when it is off. */
export const REFINE_SETUP = Symbol('REFINE_SETUP');
/** VerfijnerWorker, or null when the Verfijner is off. */
export const REFINE_WORKER = Symbol('REFINE_WORKER');
/** The enabled Werkmeester (config + bot user) or null when it is off. */
export const PLAN_SETUP = Symbol('PLAN_SETUP');
